import {
    type App,
    debounce,
    FuzzySuggestModal,
    type Menu,
    Notice,
    normalizePath,
    Plugin,
    requireApiVersion,
    type TAbstractFile,
    TFile,
    TFolder,
} from "obsidian";
import { markdownToPlaneHtml } from "./convert";
import { PlaneClient, PlaneError, type PlaneProject } from "./plane";
import { type FolderLink, loadSettings, PLANE_CLOUD_API, PlaneSettingTab, type Settings } from "./settings";
import { StickySync } from "./stickies";
import { ConfirmCleanup, STICKY_VIEW, StickyBoardView } from "./stickyView";
import { errorMessage, hash, isInFolder, withLock } from "./util";
import { WorkItemSync } from "./workItems";

const FM_PAGE = "plane_page";
const FM_PROJECT = "plane_project";
const FM_SKIP = "plane_sync";

type PushResult = "created" | "updated" | "unchanged" | "skipped" | "failed";

interface PlaneFrontmatter
{
    pageId?: string;
    projectId?: string;
    excluded: boolean;
}

export default class PlanePagesSync extends Plugin
{
    settings!: Settings;
    client!: PlaneClient;
    stickies!: StickySync;
    workItems!: WorkItemSync;
    private stickyTimer: number | null = null;
    private workItemTimer: number | null = null;
    private lastFocusPull = 0;
    private projects: PlaneProject[] | null = null;
    private timers = new Map<string, number>();
    private inFlight = 0;
    private lastError = "";
    private statusEl!: HTMLElement;
    private needsSecondPass = new Set<string>();

    async onload()
    {
        await this.loadSettings();
        this.client = new PlaneClient(() => ({
            apiBase: this.apiBase(),
            apiKey: this.token(),
            workspace: this.settings.workspace,
        }));

        this.stickies = new StickySync(this);
        this.workItems = new WorkItemSync(this);
        this.registerView(STICKY_VIEW, (leaf) => new StickyBoardView(leaf, this));

        this.statusEl = this.addStatusBarItem();
        this.statusEl.addClass("mod-clickable");
        this.statusEl.onClickEvent(() =>
        {
            if (this.lastError)
            {
                new Notice(`Plane sync: ${this.lastError}`, 10000);
            }
            else
            {
                void this.pushAll();
            }
        });
        this.renderStatus();

        this.addRibbonIcon("upload-cloud", "Push notes to Plane", () => void this.pushAll());
        this.addRibbonIcon("sticky-note", "Open Plane stickies", () => void this.openStickyBoard());
        this.addSettingTab(new PlaneSettingTab(this.app, this));
        this.registerCommands();
        this.registerMenus();

        this.app.workspace.onLayoutReady(() =>
        {
            this.registerEvent(this.app.vault.on("modify", (f) => this.onModify(f)));
            this.registerEvent(this.app.vault.on("rename", (f, old) => this.onRename(f, old)));
            this.registerEvent(this.app.vault.on("delete", (f) => void this.onDelete(f)));
            this.registerEvent(this.app.vault.on("create", (f) =>
            {
                if (f instanceof TFile)
                {
                    this.stickies.onCreate(f);
                    this.workItems.onModify(f);
                }
            }));

            // Stickies: pull on start, on a timer, and when you come back to Obsidian (e.g. after editing in Plane).
            this.restartStickyTimer();
            void this.stickies.pull({ quiet: true });
            this.restartWorkItemTimer();
            void this.workItems.pull({ quiet: true });
            this.registerDomEvent(window, "focus", () =>
            {
                if (Date.now() - this.lastFocusPull > 30_000)
                {
                    this.lastFocusPull = Date.now();
                    void this.stickies.pull({ quiet: true });
                    void this.workItems.pull({ quiet: true });
                }
            });
        });
    }

    onunload()
    {
        this.stickies?.destroy();
        this.workItems?.destroy();
        if (this.stickyTimer !== null)
        {
            window.clearInterval(this.stickyTimer);
        }
        if (this.workItemTimer !== null)
        {
            window.clearInterval(this.workItemTimer);
        }
        for (const t of this.timers.values())
        {
            window.clearTimeout(t);
        }
    }

    restartStickyTimer()
    {
        if (this.stickyTimer !== null)
        {
            window.clearInterval(this.stickyTimer);
        }
        const minutes = Math.max(1, this.settings.stickyPullMinutes);
        this.stickyTimer = window.setInterval(() => void this.stickies.pull({ quiet: true }), minutes * 60_000);
        this.registerInterval(this.stickyTimer);
    }

    restartWorkItemTimer()
    {
        if (this.workItemTimer !== null)
        {
            window.clearInterval(this.workItemTimer);
        }
        const minutes = Math.max(1, this.settings.workItemPullMinutes);
        this.workItemTimer = window.setInterval(() => void this.workItems.pull({ quiet: true }), minutes * 60_000);
        this.registerInterval(this.workItemTimer);
    }

    /** Opens the kanban board for a linked project, asking which one if there are several. */
    openBoard()
    {
        if (!this.configured)
        {
            return new Notice("Add your Plane token and workspace in this plugin's settings first.");
        }
        if (!requireApiVersion("1.14.0"))
        {
            return new Notice("Boards need Obsidian 1.14 or later. Your work item notes are still synced.");
        }
        if (!this.settings.workItemsEnabled)
        {
            return new Notice("Turn on work item sync in this plugin's settings first.");
        }
        const links = this.workItems.linkedProjects();
        if (!links.length)
        {
            return new Notice("Link a folder to a Plane project first. Boards are made for linked projects.");
        }
        const open = async (link: FolderLink) =>
        {
            const notice = new Notice(`Loading work items for ${link.projectName}…`, 0);
            try
            {
                const file = await this.workItems.boardFor(link);
                notice.hide();
                if (file)
                {
                    await this.app.workspace.getLeaf("tab").openFile(file);
                }
                else
                {
                    new Notice(`Couldn't make a board for ${link.projectName}. ${this.workItems.lastError}`, 8000);
                }
            }
            catch (e)
            {
                notice.hide();
                new Notice(`Couldn't open the board: ${errorMessage(e)}`, 8000);
            }
        };
        if (links.length === 1)
        {
            void open(links[0]);
        }
        else
        {
            new LinkedProjectModal(this.app, links, (l) => void open(l)).open();
        }
    }

    async cleanUpStickies()
    {
        if (!this.configured)
        {
            new Notice("Add your Plane token and workspace in this plugin's settings first.");
            return;
        }
        const notice = new Notice("Looking for duplicate stickies…", 0);
        try
        {
            const plan = await this.stickies.findJunk();
            notice.hide();
            if (!plan.remote.length && !plan.notes.length)
            {
                new Notice("No duplicate stickies found.");
                return;
            }
            new ConfirmCleanup(this.app, plan, () =>
            {
                const progress = new Notice("Cleaning up stickies…", 0);
                void this.stickies.cleanUp(plan).then(({ deleted, trashed, failed }) =>
                {
                    progress.hide();
                    new Notice(
                        `Deleted ${deleted} stickies in Plane and moved ${trashed} notes to trash.${
                            failed ? ` ${failed} couldn't be deleted; run the clean-up again.` : ""
                        }`,
                        8000,
                    );
                });
            }).open();
        }
        catch (e)
        {
            notice.hide();
            new Notice(`Couldn't check stickies: ${errorMessage(e)}`, 8000);
        }
    }

    async openStickyBoard()
    {
        const existing = this.app.workspace.getLeavesOfType(STICKY_VIEW)[0];
        const leaf = existing ?? this.app.workspace.getRightLeaf(false);
        if (!leaf)
        {
            return;
        }
        if (!existing)
        {
            await leaf.setViewState({ type: STICKY_VIEW, active: true });
        }
        await this.app.workspace.revealLeaf(leaf);
    }

    // ---------- settings ----------

    async loadSettings()
    {
        const { settings, migrated } = loadSettings(this.app, await this.loadData());
        this.settings = settings;
        if (migrated)
        {
            await this.saveData(this.settings);
        }
    }

    saveSettings = debounce(() => void this.saveData(this.settings), 500, true);

    resetConnection()
    {
        this.projects = null;
        this.lastError = "";
        this.renderStatus();
    }

    /** The token lives in Obsidian's secret storage; settings only keep its name. */
    token(): string
    {
        return this.settings.tokenSecret ? this.app.secretStorage.getSecret(this.settings.tokenSecret) ?? "" : "";
    }

    apiBase(): string
    {
        return this.settings.selfHosted ? this.settings.instanceUrl : PLANE_CLOUD_API;
    }

    get configured()
    {
        return !!(this.token() && this.settings.workspace && this.apiBase());
    }

    appBase()
    {
        return this.settings.selfHosted ? this.settings.instanceUrl : "https://app.plane.so";
    }

    private frontmatter(file: TFile): PlaneFrontmatter
    {
        const fm: Record<string, unknown> = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
        const str = (v: unknown) => typeof v === "string" && v ? v : undefined;
        return { pageId: str(fm[FM_PAGE]), projectId: str(fm[FM_PROJECT]), excluded: fm[FM_SKIP] === false };
    }

    pageUrl(projectId: string, pageId: string)
    {
        return `${this.appBase()}/${this.settings.workspace}/projects/${projectId}/pages/${pageId}`;
    }

    // ---------- status bar ----------

    private renderStatus()
    {
        const pending = this.timers.size + this.inFlight;
        let text = "Plane";
        if (!this.configured)
        {
            text = "Plane: not set up";
        }
        else if (this.lastError)
        {
            text = "Plane: error";
        }
        else if (pending)
        {
            text = `Plane: syncing ${pending}`;
        }
        else
        {
            text = "Plane: synced";
        }
        this.statusEl.setText(text);
        this.statusEl.setAttr("aria-label", this.lastError || "Click to push all linked folders");
    }

    // ---------- folder <-> project mapping ----------

    async getProjects(refresh = false): Promise<PlaneProject[]>
    {
        if (!this.projects || refresh)
        {
            this.projects = await this.client.listProjects();
        }
        return this.projects;
    }

    /** Nearest linked ancestor folder, or auto-link a folder under the root that matches a project name. */
    async projectFor(file: TFile): Promise<FolderLink | null>
    {
        if (this.isManaged(file))
        {
            return null;
        }
        for (let f: TFolder | null = file.parent; f && !f.isRoot(); f = f.parent)
        {
            const link = this.settings.links[f.path];
            if (link)
            {
                return link;
            }
        }
        const root = normalizePath(this.settings.rootFolder || "");
        if (!root || !file.path.startsWith(`${root}/`))
        {
            return null;
        }

        // Auto-link: Plane/<Project Name>/... matches a project by name or identifier.
        const top = file.path.slice(root.length + 1).split("/")[0];
        if (!top || top === file.name)
        {
            return null;
        }
        const folderPath = `${root}/${top}`;
        const projects = await this.getProjects();
        const want = top.trim().toLowerCase();
        const match = projects.find((p) =>
            p.name.trim().toLowerCase() === want || p.identifier?.toLowerCase() === want
        );
        if (!match)
        {
            return null;
        }
        const link = { projectId: match.id, projectName: match.name };
        this.settings.links[folderPath] = link;
        this.saveSettings();
        new Notice(`Linked "${folderPath}" to Plane project "${match.name}"`);
        return link;
    }

    /** Stickies and work item notes belong to their own sync, never to the page sync. */
    private isManaged(file: TFile)
    {
        return this.stickies.isStickyFile(file) || this.workItems.isWorkItemFile(file);
    }

    linkFolder(folder: TFolder, project: PlaneProject)
    {
        for (const [what, other] of [["stickies", this.stickies.folder], ["work items", this.workItems.folder]])
        {
            if (
                other
                && (folder.path === other || isInFolder(folder.path, other) || isInFolder(other, folder.path))
            )
            {
                new Notice(`That folder holds your ${what}, so it can't be linked to a project as well.`);
                return;
            }
        }
        // Drop links on descendants so the new link wins for the whole subtree.
        for (const p of Object.keys(this.settings.links))
        {
            if (p === folder.path || p.startsWith(`${folder.path}/`))
            {
                delete this.settings.links[p];
            }
        }
        this.settings.links[folder.path] = { projectId: project.id, projectName: project.name };
        this.saveSettings();
        new Notice(`"${folder.path}" now syncs to Plane project "${project.name}"`);
    }

    unlinkFolder(folder: TFolder)
    {
        delete this.settings.links[folder.path];
        this.saveSettings();
        new Notice(`"${folder.path}" is no longer linked to Plane`);
    }

    // ---------- push ----------

    private toHtml(file: TFile, content: string)
    {
        let pendingLink = false;
        const html = markdownToPlaneHtml(content, {
            resolveLink: (target) =>
            {
                const dest = this.app.metadataCache.getFirstLinkpathDest(target, file.path);
                if (!dest)
                {
                    return null;
                }
                const fm = this.frontmatter(dest);
                if (fm.pageId && fm.projectId)
                {
                    return { title: dest.basename, url: this.pageUrl(fm.projectId, fm.pageId) };
                }
                if (dest.extension === "md")
                {
                    pendingLink = true; // may get a page later in this batch
                }
                return { title: dest.basename };
            },
        });
        return { html, pendingLink };
    }

    pushFile(file: TFile, opts: { force?: boolean; quiet?: boolean; } = {}): Promise<PushResult>
    {
        // One push per note at a time, so a new note can't be created in Plane twice.
        return withLock(`page:${file.path}`, () => this.pushFileNow(file, opts));
    }

    private async pushFileNow(file: TFile, opts: { force?: boolean; quiet?: boolean; }): Promise<PushResult>
    {
        if (file.extension !== "md" || !this.configured)
        {
            return "skipped";
        }
        this.inFlight++;
        this.renderStatus();
        try
        {
            const fm = this.frontmatter(file);
            if (fm.excluded)
            {
                return "skipped";
            }

            const link = await this.projectFor(file);
            if (!link)
            {
                if (!opts.quiet)
                {
                    new Notice(
                        `"${file.parent?.path}" isn't linked to a Plane project. Right-click the folder and choose “Link to Plane project”.`,
                    );
                }
                return "skipped";
            }

            const content = await this.app.vault.cachedRead(file);
            const { html, pendingLink } = this.toHtml(file, content);
            if (pendingLink)
            {
                this.needsSecondPass.add(file.path);
            }
            const name = file.basename;
            const contentHash = hash(`${name}\n${html}`);

            let pageId = fm.pageId;
            const pageProject = fm.projectId;
            const rec = this.settings.pages[file.path];

            // Note moved to a folder linked to a different project: Plane can't move pages, so recreate.
            if (pageId && pageProject && pageProject !== link.projectId)
            {
                await this.client.archivePage(pageProject, pageId).catch(() => undefined);
                pageId = undefined;
            }

            if (pageId && !opts.force && rec?.pageId === pageId && rec.hash === contentHash)
            {
                return "unchanged";
            }

            let result: PushResult = "updated";
            if (pageId)
            {
                try
                {
                    await this.client.updatePage(link.projectId, pageId, name, html);
                }
                catch (e)
                {
                    if (e instanceof PlaneError && e.status === 404)
                    {
                        pageId = undefined; // deleted in Plane: recreate
                    }
                    else if (e instanceof PlaneError && e.status === 400)
                    {
                        const page = await this.client.getPage(link.projectId, pageId).catch(() => null);
                        if (page?.is_locked)
                        {
                            throw new Error(`"${name}" is locked in Plane. Unlock it to keep syncing.`);
                        }
                        if (page?.archived_at)
                        {
                            await this.client.restorePage(link.projectId, pageId);
                            await this.client.updatePage(link.projectId, pageId, name, html);
                        }
                        else
                        {
                            throw e;
                        }
                    }
                    else
                    {
                        throw e;
                    }
                }
            }
            if (!pageId)
            {
                const page = await this.client.createPage(link.projectId, name, html, file.path);
                pageId = page.id;
                result = "created";
                const id = pageId;
                await this.app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) =>
                {
                    f[FM_PAGE] = id;
                    f[FM_PROJECT] = link.projectId;
                });
            }

            this.settings.pages[file.path] = { pageId: pageId, projectId: link.projectId, hash: contentHash };
            this.saveSettings();
            this.lastError = "";
            return result;
        }
        catch (e)
        {
            this.lastError = e instanceof Error ? e.message : String(e);
            if (!opts.quiet)
            {
                new Notice(`Plane sync failed: ${this.lastError}`, 8000);
            }
            console.error("[plane-sync]", e);
            return "failed";
        }
        finally
        {
            this.inFlight--;
            this.renderStatus();
        }
    }

    private filesInLinkedFolders(): TFile[]
    {
        const root = normalizePath(this.settings.rootFolder || "");
        const linked = Object.keys(this.settings.links);
        return this.app.vault.getMarkdownFiles().filter((f) =>
            !this.isManaged(f)
            && (linked.some((p) => f.path.startsWith(`${p}/`)) || (root && f.path.startsWith(`${root}/`)))
        );
    }

    async pushMany(files: TFile[], label: string)
    {
        if (!this.configured)
        {
            return new Notice("Add your Plane token and workspace in this plugin's settings first.");
        }
        const counts: Record<PushResult, number> = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
        const notice = new Notice(`Pushing ${files.length} notes to Plane...`, 0);
        this.needsSecondPass.clear();
        for (const [i, f] of files.entries())
        {
            notice.setMessage(`Pushing to Plane: ${i + 1}/${files.length}\n${f.basename}`);
            counts[await this.pushFile(f, { quiet: true })]++;
        }
        // Notes that linked to notes created in this batch can now point at real Plane URLs.
        const again = files.filter((f) => this.needsSecondPass.has(f.path));
        for (const f of again)
        {
            await this.pushFile(f, { quiet: true });
        }
        notice.hide();
        const parts = (["created", "updated", "unchanged", "failed"] as const).filter((k) => counts[k]).map((k) =>
            `${counts[k]} ${k}`
        );
        new Notice(
            `${label}: ${parts.join(", ") || "nothing to sync"}${counts.failed ? `\n${this.lastError}` : ""}`,
            counts.failed ? 10000 : 4000,
        );
    }

    pushAll()
    {
        return this.pushMany(this.filesInLinkedFolders(), "Plane sync");
    }

    pushFolder(folder: TFolder)
    {
        const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${folder.path}/`));
        return this.pushMany(files, `"${folder.name}"`);
    }

    // ---------- vault events ----------

    private isTracked(file: TFile)
    {
        if (this.isManaged(file))
        {
            return false;
        }
        if (this.settings.pages[file.path])
        {
            return true;
        }
        const root = normalizePath(this.settings.rootFolder || "");
        if (root && file.path.startsWith(`${root}/`))
        {
            return true;
        }
        return Object.keys(this.settings.links).some((p) => file.path.startsWith(`${p}/`));
    }

    private schedule(file: TFile)
    {
        const prev = this.timers.get(file.path);
        if (prev)
        {
            window.clearTimeout(prev);
        }
        const t = window.setTimeout(() =>
        {
            this.timers.delete(file.path);
            const current = this.app.vault.getAbstractFileByPath(file.path);
            if (current instanceof TFile)
            {
                void this.pushFile(current, { quiet: true });
            }
            this.renderStatus();
        }, Math.max(1, this.settings.debounceSec) * 1000);
        this.timers.set(file.path, t);
        this.renderStatus();
    }

    private onModify(f: TAbstractFile)
    {
        if (f instanceof TFile && this.stickies.isStickyFile(f))
        {
            this.stickies.onModify(f);
            return;
        }
        if (f instanceof TFile && this.workItems.isWorkItemFile(f))
        {
            this.workItems.onModify(f);
            return;
        }
        if (!this.settings.autoPush || !this.configured)
        {
            return;
        }
        if (f instanceof TFile && f.extension === "md" && this.isTracked(f))
        {
            this.schedule(f);
        }
    }

    private onRename(f: TAbstractFile, oldPath: string)
    {
        if (f instanceof TFolder)
        {
            // Keep folder links and page records pointing at the new paths.
            for (const key of Object.keys(this.settings.links))
            {
                if (key === oldPath || key.startsWith(`${oldPath}/`))
                {
                    this.settings.links[f.path + key.slice(oldPath.length)] = this.settings.links[key];
                    delete this.settings.links[key];
                }
            }
            for (const key of Object.keys(this.settings.pages))
            {
                if (key.startsWith(`${oldPath}/`))
                {
                    this.settings.pages[f.path + key.slice(oldPath.length)] = this.settings.pages[key];
                    delete this.settings.pages[key];
                }
            }
            // The stickies folder (or a parent of it) was renamed: follow it.
            const stickies = this.stickies.folder;
            if (stickies === oldPath || isInFolder(stickies, oldPath))
            {
                this.settings.stickiesFolder = f.path + stickies.slice(oldPath.length);
            }
            const items = this.workItems.folder;
            if (items === oldPath || isInFolder(items, oldPath))
            {
                this.settings.workItemsFolder = f.path + items.slice(oldPath.length);
            }
            for (const rec of Object.values(this.settings.stickies))
            {
                if (isInFolder(rec.path, oldPath))
                {
                    rec.path = f.path + rec.path.slice(oldPath.length);
                }
            }
            this.saveSettings();
            return;
        }
        if (!(f instanceof TFile))
        {
            return;
        }
        if (this.stickies.isStickyFile(f) || isInFolder(oldPath, this.stickies.folder))
        {
            this.stickies.onRename(f, oldPath);
            return;
        }
        if (this.workItems.isWorkItemFile(f) || isInFolder(oldPath, this.workItems.folder))
        {
            // A note renamed from "Untitled" (or moved into a project folder) may now be ready to create.
            this.workItems.onModify(f);
            return;
        }
        const rec = this.settings.pages[oldPath];
        if (rec)
        {
            this.settings.pages[f.path] = rec;
            delete this.settings.pages[oldPath];
            this.saveSettings();
        }
        if (this.settings.autoPush && f.extension === "md" && this.isTracked(f))
        {
            this.schedule(f);
        }
    }

    private async onDelete(f: TAbstractFile)
    {
        // A deleted folder takes all its notes with it, so handle every record inside it.
        const paths = f instanceof TFolder
            ? [
                ...Object.keys(this.settings.pages).filter((p) => isInFolder(p, f.path)),
                ...Object.values(this.settings.stickies).map((r) => r.path).filter((p) => isInFolder(p, f.path)),
            ]
            : f instanceof TFile
            ? [f.path]
            : [];
        for (const path of paths)
        {
            if (isInFolder(path, this.stickies.folder))
            {
                this.stickies.onDelete(path);
            }
            else
            {
                await this.archiveDeleted(path);
            }
        }
    }

    private async archiveDeleted(path: string)
    {
        const rec = this.settings.pages[path];
        if (!rec)
        {
            return;
        }
        delete this.settings.pages[path];
        this.saveSettings();
        if (this.settings.onDelete === "archive" && this.configured)
        {
            try
            {
                await this.client.archivePage(rec.projectId, rec.pageId);
                new Notice(`Archived "${path.slice(path.lastIndexOf("/") + 1, -3)}" in Plane`);
            }
            catch (e)
            {
                console.error("[plane-sync] archive failed", e);
            }
        }
    }

    // ---------- commands & menus ----------

    private registerCommands()
    {
        this.addCommand({
            id: "push-current",
            name: "Push current note",
            checkCallback: (checking) =>
            {
                const f = this.app.workspace.getActiveFile();
                if (f?.extension !== "md")
                {
                    return false;
                }
                if (!checking)
                {
                    void this.pushFile(f, { force: true }).then((r) =>
                        r !== "failed" && r !== "skipped" && new Notice(`Plane: ${r} "${f.basename}"`)
                    );
                }
                return true;
            },
        });
        this.addCommand({
            id: "open-stickies",
            name: "Open sticky board",
            callback: () => void this.openStickyBoard(),
        });
        this.addCommand({
            id: "sync-work-items",
            name: "Sync work items now",
            callback: () => void this.workItems.pull(),
        });
        this.addCommand({ id: "open-board", name: "Open work item board", callback: () => void this.openBoard() });
        this.addCommand({
            id: "clean-up-stickies",
            name: "Clean up duplicate stickies",
            callback: () => void this.cleanUpStickies(),
        });
        this.addCommand({ id: "sync-stickies", name: "Sync stickies now", callback: () => void this.stickies.pull() });
        this.addCommand({
            id: "new-sticky",
            name: "New sticky",
            callback: async () =>
            {
                await this.openStickyBoard();
                const file = await this.stickies.newSticky();
                await this.app.workspace.getLeaf("tab").openFile(file);
            },
        });
        this.addCommand({ id: "push-all", name: "Push all linked folders", callback: () => void this.pushAll() });
        this.addCommand({
            id: "link-folder",
            name: "Link current note's folder to a project",
            checkCallback: (checking) =>
            {
                const folder = this.app.workspace.getActiveFile()?.parent;
                if (!folder || folder.isRoot())
                {
                    return false;
                }
                if (!checking)
                {
                    this.pickProject((p) => this.linkFolder(folder, p));
                }
                return true;
            },
        });
        this.addCommand({
            id: "new-project-folder",
            name: "Create folder for a project",
            callback: () =>
                this.pickProject(async (p) =>
                {
                    const path = normalizePath(
                        `${this.settings.rootFolder || ""}/${p.name.replace(/[\\/:*?"<>|]/g, "-")}`,
                    );
                    if (!this.app.vault.getAbstractFileByPath(path))
                    {
                        await this.app.vault.createFolder(path);
                    }
                    const folder = this.app.vault.getAbstractFileByPath(path);
                    if (folder instanceof TFolder)
                    {
                        this.linkFolder(folder, p);
                    }
                }),
        });
        this.addCommand({
            id: "open-in-plane",
            name: "Open current note in Plane",
            checkCallback: (checking) =>
            {
                const f = this.app.workspace.getActiveFile();
                const url = f && this.urlFor(f);
                if (!url)
                {
                    return false;
                }
                if (!checking)
                {
                    window.open(url);
                }
                return true;
            },
        });
        this.addCommand({
            id: "copy-plane-link",
            name: "Copy Plane link for current note",
            checkCallback: (checking) =>
            {
                const f = this.app.workspace.getActiveFile();
                const url = f && this.urlFor(f);
                if (!url)
                {
                    return false;
                }
                if (!checking)
                {
                    void navigator.clipboard.writeText(url).then(() => new Notice("Plane link copied"));
                }
                return true;
            },
        });
        this.addCommand({
            id: "exclude-current",
            name: "Stop syncing current note",
            checkCallback: (checking) =>
            {
                const f = this.app.workspace.getActiveFile();
                if (f?.extension !== "md")
                {
                    return false;
                }
                if (!checking)
                {
                    void this.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) =>
                    {
                        fm[FM_SKIP] = false;
                    })
                        .then(() =>
                            new Notice(
                                `"${f.basename}" won't sync to Plane. Remove ${FM_SKIP} from its properties to resume.`,
                            )
                        );
                }
                return true;
            },
        });
    }

    urlFor(file: TFile): string | null
    {
        const fm = this.frontmatter(file);
        return fm.pageId && fm.projectId ? this.pageUrl(fm.projectId, fm.pageId) : null;
    }

    private registerMenus()
    {
        this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, f: TAbstractFile) =>
        {
            if (f instanceof TFolder && !f.isRoot())
            {
                const link = this.settings.links[f.path];
                menu.addItem((i) =>
                    i.setTitle(link ? `Change Plane project (${link.projectName})` : "Link to Plane project…")
                        .setIcon("link").onClick(() => this.pickProject((p) => this.linkFolder(f, p)))
                );
                if (link)
                {
                    menu.addItem((i) =>
                        i.setTitle("Push folder to Plane").setIcon("upload-cloud").onClick(() =>
                            void this.pushFolder(f)
                        )
                    );
                    menu.addItem((i) =>
                        i.setTitle("Unlink from Plane").setIcon("unlink").onClick(() => this.unlinkFolder(f))
                    );
                }
            }
            else if (f instanceof TFile && f.extension === "md")
            {
                const url = this.urlFor(f);
                menu.addItem((i) =>
                    i.setTitle("Push to Plane").setIcon("upload-cloud")
                        .onClick(() => void this.pushFile(f, { force: true }))
                );
                if (url)
                {
                    menu.addItem((i) =>
                        i.setTitle("Open in Plane").setIcon("external-link").onClick(() => window.open(url))
                    );
                }
            }
        }));
    }

    pickProject(onPick: (p: PlaneProject) => void | Promise<void>)
    {
        if (!this.configured)
        {
            return new Notice("Add your Plane token and workspace in this plugin's settings first.");
        }
        this.getProjects(true)
            .then((projects) => new ProjectModal(this.app, projects, onPick).open())
            .catch((e: unknown) =>
                new Notice(`Couldn't load Plane projects: ${e instanceof Error ? e.message : String(e)}`, 8000)
            );
    }
}

class LinkedProjectModal extends FuzzySuggestModal<FolderLink>
{
    constructor(app: App, private links: FolderLink[], private onPick: (l: FolderLink) => void)
    {
        super(app);
        this.setPlaceholder("Pick a project");
    }
    getItems()
    {
        return this.links;
    }
    getItemText(l: FolderLink)
    {
        return l.projectName;
    }
    onChooseItem(l: FolderLink)
    {
        this.onPick(l);
    }
}

export class ProjectModal extends FuzzySuggestModal<PlaneProject>
{
    constructor(app: App, private projects: PlaneProject[], private onPick: (p: PlaneProject) => void | Promise<void>)
    {
        super(app);
        this.setPlaceholder("Pick a Plane project");
    }
    getItems()
    {
        return this.projects;
    }
    getItemText(p: PlaneProject)
    {
        return `${p.name}${p.identifier ? `  (${p.identifier})` : ""}`;
    }
    onChooseItem(p: PlaneProject)
    {
        void this.onPick(p);
    }
}
