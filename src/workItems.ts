// Work items: Plane -> Obsidian, plus board moves back to Plane when you allow it.
//
// Each work item is one note in `<work items folder>/<project name>/`, with the item's id in the
// `plane_work_item` property. A Bases kanban file (Board.base) next to the notes groups them by
// `plane_state`, so dragging a card changes that property.
//
// Per item we remember the Plane state, a hash of everything else Plane sent, and a hash of the
// description at the last sync. On each pull:
//   - Plane changed             -> refresh the note (properties, and the body if the description changed)
//   - you moved the card        -> push the new state if "Send changes to Plane" is on, otherwise put it back
//   - a new note in a project folder (no plane_work_item yet) -> create the work item, when sending is on
//   - you edited the body and the description changed in Plane -> your text is saved in Conflicts/
// After creation only the state is sent. Titles, descriptions and other fields of existing items are read-only.
import { getFrontMatterInfo, Notice, normalizePath, parseYaml, stringifyYaml, TFile } from "obsidian";
import { markdownToPlaneHtml } from "./convert";
import type PlanePagesSync from "./main";
import { PlaneError, type PlaneProject, type PlaneState, type PlaneWorkItem } from "./plane";
import type { FolderLink, WorkItemRecord } from "./settings";
import { normalizeMarkdown, planeHtmlToMarkdown } from "./stickyConvert";
import { errorMessage, hash, isInFolder, withLock } from "./util";

export const FM_ITEM = "plane_work_item";
const FM_KEY = "plane_key";
const FM_STATE = "plane_state";
const FM_GROUP = "plane_state_group";
const FM_PRIORITY = "plane_priority";
const FM_ASSIGNEES = "plane_assignees";
const FM_LABELS = "plane_labels";
const FM_TARGET = "plane_target_date";
const FM_URL = "plane_url";

const FM_SKIP = "plane_sync";

const MAX_ITEMS_PER_PROJECT = 1000;
const MAX_CREATES_PER_MINUTE = 10;
const PRIORITIES = ["urgent", "high", "medium", "low", "none"];
const UNTITLED = /^untitled( \d+)?$/i;
const GROUP_ORDER = ["backlog", "unstarted", "started", "completed", "cancelled"];

export interface Snapshot
{
    key: string; // e.g. HOLD-12
    title: string;
    body: string;
    state: string;
    group: string;
    priority: string;
    assignees: string[];
    labels: string[];
    target: string;
    url: string;
}

interface Totals
{
    created: number;
    updated: number;
    pushed: number;
    reverted: number;
    conflicts: number;
    failed: number;
}

interface LocalItem
{
    id?: string;
    state?: string;
    priority?: string;
    skip: boolean;
    body: string;
}

/** Property values can be text, a number or a list depending on how they were set. Read them as text. */
export function textOf(v: unknown): string | undefined
{
    const first = Array.isArray(v) ? (v as unknown[])[0] : v;
    if (typeof first === "string" || typeof first === "number")
    {
        const t = String(first).trim();
        return t || undefined;
    }
    return undefined;
}

function parentOf(file: TFile)
{
    return file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
}

/** Finds a state by name, ignoring case and extra spaces. */
export function findState(states: PlaneState[], name: string): PlaneState | undefined
{
    const want = name.trim().toLowerCase();
    return states.find((s) => s.name === name) ?? states.find((s) => s.name.trim().toLowerCase() === want);
}

function planeErrorText(e: unknown)
{
    if (e instanceof PlaneError && (e.status === 401 || e.status === 403))
    {
        return `Plane refused it (${e.status}). Check that your token can edit work items in this project.`;
    }
    return errorMessage(e);
}

function stamp()
{
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${
        pad(d.getMinutes())
    }`;
}

export function safeName(name: string, max = 80)
{
    const clean = name.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim();
    return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

function personName(p: NonNullable<PlaneWorkItem["assignees"]>[number]): string
{
    if (typeof p === "string")
    {
        return ""; // an id we couldn't expand: a UUID is no use in a note
    }
    const full = [p.first_name, p.last_name].filter(Boolean).join(" ");
    return (p.display_name || full || p.email || "").trim();
}

/** Turns a raw Plane work item into the values we write to the note. */
export function snapshotOf(
    item: PlaneWorkItem,
    project: PlaneProject,
    states: PlaneState[],
    appBase: string,
    workspace: string,
): Snapshot
{
    const byId = new Map(states.map((s) => [s.id, s]));
    let stateName = "";
    let group = "";
    if (typeof item.state === "string")
    {
        const s = byId.get(item.state);
        stateName = s?.name ?? "";
        group = s?.group ?? "";
    }
    else if (item.state)
    {
        const s = item.state.id ? byId.get(item.state.id) : undefined;
        stateName = item.state.name ?? s?.name ?? "";
        group = item.state.group ?? s?.group ?? "";
    }
    const key = `${project.identifier || project.name}-${item.sequence_id ?? "?"}`;
    const body = planeHtmlToMarkdown(item.description_html)
        || normalizeMarkdown(item.description_stripped ?? "");
    return {
        key,
        title: item.name?.trim() || "Untitled",
        body,
        state: stateName || "No state",
        group,
        priority: item.priority || "none",
        assignees: (item.assignees ?? []).map(personName).filter(Boolean),
        labels: (item.labels ?? []).map((l) => (typeof l === "string" ? "" : l.name ?? "")).filter(Boolean),
        target: item.target_date ?? "",
        url: `${appBase.replace(/\/+$/, "")}/${workspace}/browse/${key}/`,
    };
}

/** Hash of everything except the state and the description (those are tracked separately). */
export function restHash(s: Snapshot)
{
    return hash(JSON.stringify([s.key, s.title, s.priority, s.assignees, s.labels, s.target]));
}

const bodyHash = (md: string) => hash(normalizeMarkdown(md));

export function stateOrder(states: PlaneState[]): PlaneState[]
{
    const rank = (g?: string) =>
    {
        const i = GROUP_ORDER.indexOf(g ?? "");
        return i < 0 ? GROUP_ORDER.length : i;
    };
    return [...states].sort((a, b) =>
        rank(a.group) - rank(b.group) || (a.sequence ?? 0) - (b.sequence ?? 0) || a.name.localeCompare(b.name)
    );
}

// ---------- the board ----------
//
// Bases draws each card from the view's `order`: the first entry is the title, the rest are lines.
// The title formula drops the "KEY-12 " prefix from the file name, and the card formula renders one
// row of chips with html(). The classes in it (pps-wi-*) are styled in styles.css, which also uses
// :has() to colour the card edge and the column headers by state group. Formulas use HTML attributes
// in single quotes, so they can sit inside the formula's double-quoted strings.

const TITLE_FORMULA =
    'if(plane_key && file.name.startsWith(plane_key + " "), file.name.slice(plane_key.length + 1), file.name)';

/** Escapes a value for an HTML attribute quoted with single quotes. */
const attr = (expr: string) => `escapeHTML(${expr}).replace("'", "&#39;")`;

const CARD_FORMULA = `html(${
    [
        `"<div class='pps-wi' data-group='" + if(plane_state_group, plane_state_group, "none") + "' data-priority='" + if(plane_priority, plane_priority, "none") + "'>"`,
        `"<span class='pps-wi-priority' aria-label='Priority: " + if(plane_priority, plane_priority.title(), "None") + "'><i></i><i></i><i></i></span>"`,
        `"<span class='pps-wi-key'>" + escapeHTML(plane_key) + "</span>"`,
        `if(plane_target_date, "<span class='pps-wi-due" + if(date(plane_target_date) < today() && plane_state_group != "completed" && plane_state_group != "cancelled", " is-overdue", "") + "' aria-label='Due " + date(plane_target_date).format("D MMMM YYYY") + "'>" + date(plane_target_date).format("D MMM") + "</span>", "")`,
        `if(plane_labels, list(plane_labels).slice(0, 1).map("<span class='pps-wi-label'>" + escapeHTML(value) + "</span>").join("") + if(list(plane_labels).length > 1, "<span class='pps-wi-more' aria-label='" + ${
            attr('list(plane_labels).slice(1).join(", ")')
        } + "'>+" + (list(plane_labels).length - 1).toString() + "</span>", ""), "")`,
        `"<span class='pps-wi-spacer'></span>"`,
        `if(plane_assignees, list(plane_assignees).slice(0, 3).map("<span class='pps-wi-avatar' data-i='" + ${
            attr("value.slice(0, 1).title()")
        } + "' aria-label='" + ${
            attr("value")
        } + "'>" + escapeHTML(value.slice(0, 1).title()) + "</span>").join(""), "")`,
        `"</div>"`,
    ].join(" + ")
})`;

const DISPLAY_NAMES: Array<[string, string]> = [
    ["formula.title", "Title"],
    ["formula.card", ""],
    [FM_STATE, "State"],
    [FM_GROUP, "State group"],
    [FM_PRIORITY, "Priority"],
    [FM_ASSIGNEES, "Assignees"],
    [FM_LABELS, "Labels"],
    [FM_TARGET, "Due"],
    [FM_KEY, "Key"],
    [FM_URL, "Plane link"],
    [FM_ITEM, "Plane id"],
];

/** The Bases file for a project: a kanban view grouped by state, columns in Plane's order. */
export function boardYaml(folder: string, states: PlaneState[]): string
{
    const q = (v: string) => JSON.stringify(v);
    const sq = (v: string) => `'${v.replace(/'/g, "''")}'`; // YAML single-quoted scalar
    return [
        "# Made by Plane Sync. Change it however you like; the plugin only rewrites this file while it is untouched.",
        "filters:",
        "  and:",
        `    - ${sq(`file.inFolder(${q(folder)})`)}`,
        "formulas:",
        `  title: ${sq(TITLE_FORMULA)}`,
        `  card: ${sq(CARD_FORMULA)}`,
        "properties:",
        ...DISPLAY_NAMES.flatMap(([key, name]) => [`  ${key}:`, `    displayName: ${q(name)}`]),
        "views:",
        "  - type: kanban",
        "    name: Board",
        "    columnWidth: 300",
        "    groupBy:",
        `      property: note.${FM_STATE}`,
        "      direction: ASC",
        "    groupOrder:",
        ...stateOrder(states).map((s) => `      - ${q(s.name)}`),
        "    order:",
        "      - formula.title",
        "      - formula.card",
        "",
    ].join("\n");
}

export class WorkItemSync
{
    private pulling: Promise<void> | null = null;
    private timers = new Map<string, number>();
    private created = new Map<string, string>(); // id -> path, for notes whose metadata isn't cached yet
    private states = new Map<string, PlaneState[]>();
    private noticeAt = 0;
    private creating = new Map<string, Promise<void>>(); // path -> creation in progress
    private createdAt: number[] = [];
    lastError = "";
    lastPull = 0;

    constructor(private plugin: PlanePagesSync)
    {}

    get app()
    {
        return this.plugin.app;
    }

    private get settings()
    {
        return this.plugin.settings;
    }

    get folder()
    {
        const f = this.settings.workItemsFolder.trim();
        return f ? normalizePath(f) : "";
    }

    private get conflictsFolder()
    {
        return normalizePath(`${this.folder}/Conflicts`);
    }

    isWorkItemFile(file: { path: string; })
    {
        return !!this.folder && isInFolder(file.path, this.folder);
    }

    destroy()
    {
        for (const t of this.timers.values())
        {
            window.clearTimeout(t);
        }
        this.timers.clear();
    }

    projectFolder(projectName: string)
    {
        return normalizePath(`${this.folder}/${safeName(projectName) || "Project"}`);
    }

    boardPath(projectName: string)
    {
        return normalizePath(`${this.projectFolder(projectName)}/Board.base`);
    }

    /** Work items are synced for every project that has a linked folder. */
    linkedProjects(): FolderLink[]
    {
        const seen = new Map<string, FolderLink>();
        for (const link of Object.values(this.settings.links))
        {
            if (!seen.has(link.projectId))
            {
                seen.set(link.projectId, link);
            }
        }
        return [...seen.values()];
    }

    // ---------- pull ----------

    pull(opts: { quiet?: boolean; } = {}): Promise<void>
    {
        if (!this.settings.workItemsEnabled || !this.plugin.configured || !this.folder)
        {
            return Promise.resolve();
        }
        if (this.pulling)
        {
            return this.pulling;
        }
        this.pulling = this.doPull(!!opts.quiet).finally(() =>
        {
            this.pulling = null;
        });
        return this.pulling;
    }

    private async doPull(quiet: boolean)
    {
        const links = this.linkedProjects();
        if (!links.length)
        {
            if (!quiet)
            {
                new Notice("Link a folder to a Plane project first. Work items are synced for linked projects.");
            }
            return;
        }
        const totals: Totals = { created: 0, updated: 0, pushed: 0, reverted: 0, conflicts: 0, failed: 0 };
        for (const link of links)
        {
            try
            {
                await this.syncProject(link, totals);
                this.lastError = "";
            }
            catch (e)
            {
                totals.failed++;
                this.lastError = errorMessage(e);
                console.error("[plane-sync] work item sync failed", e);
            }
        }
        this.lastPull = Date.now();
        this.plugin.saveSettings();
        if (!quiet || totals.conflicts || totals.failed)
        {
            const parts = (["created", "updated", "pushed", "reverted", "conflicts", "failed"] as const)
                .filter((k) => totals[k])
                .map((k) => `${totals[k]} ${k}`);
            new Notice(
                `Work items: ${parts.join(", ") || "up to date"}${totals.failed ? `\n${this.lastError}` : ""}`,
                totals.failed || totals.conflicts ? 10000 : 4000,
            );
        }
    }

    private async syncProject(link: FolderLink, totals: Totals)
    {
        const project = (await this.plugin.getProjects()).find((p) => p.id === link.projectId);
        if (!project)
        {
            throw new Error(`The project "${link.projectName}" no longer exists in Plane. Unlink its folder.`);
        }
        const client = this.plugin.client;
        const states = await client.listStates(project.id);
        this.states.set(project.id, states);
        const items = (await client.listWorkItems(project.id)).filter((i) => !i.archived_at && !i.is_draft);
        if (items.length > MAX_ITEMS_PER_PROJECT)
        {
            throw new Error(
                `"${project.name}" has ${items.length} work items. Syncing more than ${MAX_ITEMS_PER_PROJECT} per project isn't supported yet.`,
            );
        }

        const dir = this.projectFolder(project.name);
        await this.ensureFolder(dir);
        // A note being turned into a work item right now must not get a second note from this pull.
        await Promise.allSettled([...this.creating.values()]);
        const index = this.index();
        for (const item of items)
        {
            const snap = snapshotOf(item, project, states, this.plugin.appBase(), this.settings.workspace);
            try
            {
                await withLock(`wi:${item.id}`, () => this.reconcile(item.id, project, snap, dir, index, totals));
            }
            catch (e)
            {
                totals.failed++;
                this.lastError = errorMessage(e);
                console.error("[plane-sync] work item failed", item.id, e);
            }
        }
        await this.ensureBoard(project, states, dir);

        // New notes that weren't sent yet (sending was off, or paused): send them now.
        if (this.settings.workItemsPush)
        {
            for (const f of this.app.vault.getMarkdownFiles())
            {
                const fm: Record<string, unknown> = this.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
                if (parentOf(f) === dir && !textOf(fm[FM_ITEM]) && ![...this.created.values()].includes(f.path))
                {
                    await this.maybeCreate(f);
                }
            }
        }
    }

    private async reconcile(
        id: string,
        project: PlaneProject,
        snapIn: Snapshot,
        dir: string,
        index: Map<string, TFile>,
        totals: Totals,
    )
    {
        let snap = snapIn;
        const records = this.settings.workItems;
        let rec = records[id];
        const file = index.get(id);

        if (!file)
        {
            const path = await this.uniquePath(dir, `${snap.key} ${safeName(snap.title)}`);
            const created = await this.app.vault.create(path, this.render(id, snap));
            this.created.set(id, created.path);
            records[id] = {
                project: project.id,
                rest: restHash(snap),
                state: snap.state,
                body: bodyHash(snap.body),
                autoName: created.basename,
            };
            totals.created++;
            return;
        }

        const local = await this.readLocal(file);

        // 1. You moved the card since the last sync.
        if (rec && local.state !== undefined && local.state !== rec.state && snap.state === rec.state)
        {
            const outcome = await this.handleMove(file, id, rec, local.state);
            if (outcome === "pushed")
            {
                snap = { ...snap, state: local.state, group: this.groupOf(project.id, local.state) };
                totals.pushed++;
            }
            else
            {
                totals.reverted++;
            }
        }

        // 2. Plane changed (or the note lost its properties): refresh from Plane.
        const afterMove = await this.readLocal(file);
        const restChanged = !rec || rec.rest !== restHash(snap);
        const stateChanged = !rec || rec.state !== snap.state || afterMove.state !== snap.state;
        const remoteBodyChanged = !rec || rec.body !== bodyHash(snap.body);
        if (!restChanged && !stateChanged && !remoteBodyChanged)
        {
            return;
        }

        if (remoteBodyChanged && afterMove.body)
        {
            // Without a record we can't tell your edits from Plane's text, so keep a copy to be safe.
            const edited = !rec || rec.body !== bodyHash(afterMove.body);
            if (edited && bodyHash(afterMove.body) !== bodyHash(snap.body))
            {
                await this.saveConflictCopy(snap, afterMove.body);
                totals.conflicts++;
            }
        }
        await this.applyProps(file, id, snap);
        if (remoteBodyChanged || !rec)
        {
            await this.writeBody(file, snap.body);
        }
        rec = {
            project: project.id,
            rest: restHash(snap),
            state: snap.state,
            body: bodyHash(snap.body),
            autoName: rec?.autoName,
        };
        records[id] = rec;
        await this.maybeRename(file, rec, snap);
        totals.updated++;
    }

    // ---------- moving cards ----------

    onModify(file: TFile)
    {
        if (!this.settings.workItemsEnabled || !this.isWorkItemFile(file))
        {
            return;
        }
        const prev = this.timers.get(file.path);
        if (prev)
        {
            window.clearTimeout(prev);
        }
        this.timers.set(
            file.path,
            window.setTimeout(() =>
            {
                this.timers.delete(file.path);
                const current = this.app.vault.getAbstractFileByPath(file.path);
                if (current instanceof TFile)
                {
                    void this.syncMove(current);
                }
            }, 2000),
        );
    }

    /** Looks at one note after you edit it: if you moved its card, push or undo the move. */
    async syncMove(file: TFile)
    {
        try
        {
            if (!file.path.endsWith(".md"))
            {
                return;
            }
            const local = await this.readLocal(file);
            if (!local.id)
            {
                await this.maybeCreate(file);
                return;
            }
            const id = local.id;
            await withLock(`wi:${id}`, async () =>
            {
                const rec = this.settings.workItems[id];
                const now = await this.readLocal(file);
                if (!rec || now.state === undefined || now.state === rec.state)
                {
                    return;
                }
                await this.handleMove(file, id, rec, now.state);
                this.plugin.saveSettings();
            });
        }
        catch (e)
        {
            this.lastError = errorMessage(e);
            console.error("[plane-sync] work item move failed", e);
        }
    }

    /** Pushes the move if allowed and possible, otherwise puts the card back. */
    private async handleMove(
        file: TFile,
        id: string,
        rec: WorkItemRecord,
        to: string,
    ): Promise<"pushed" | "reverted">
    {
        if (!this.settings.workItemsPush || !this.plugin.configured)
        {
            this.tell(
                "Moves aren't sent to Plane, so the card was put back. Turn on “Send changes to Plane” under Work items in this plugin's settings.",
            );
            await this.setState(file, rec.project, rec.state);
            return "reverted";
        }
        const states = await this.statesFor(rec.project);
        const target = findState(states, to);
        if (!target)
        {
            this.tell(`“${to}” isn't a state in this Plane project, so the card was put back.`, true);
            await this.setState(file, rec.project, rec.state);
            return "reverted";
        }
        if (target.name === rec.state)
        {
            // Same state, written differently (case, spacing, as a list): just tidy the property.
            await this.setState(file, rec.project, target.name);
            return "reverted";
        }
        try
        {
            await this.plugin.client.updateWorkItem(rec.project, id, { state: target.id });
        }
        catch (e)
        {
            console.error("[plane-sync] moving work item failed", e);
            this.tell(`Couldn't move “${file.basename}” in Plane. ${planeErrorText(e)}`, true);
            await this.setState(file, rec.project, rec.state);
            return "reverted";
        }
        rec.state = target.name;
        await this.setState(file, rec.project, target.name);
        new Notice(`Moved “${file.basename}” to ${target.name} in Plane`, 2500);
        return "pushed";
    }

    private async statesFor(projectId: string)
    {
        let states = this.states.get(projectId);
        if (!states)
        {
            states = await this.plugin.client.listStates(projectId);
            this.states.set(projectId, states);
        }
        return states;
    }

    // ---------- new work items ----------

    /** The linked project whose folder directly holds this note, if any. */
    private projectOfNote(file: TFile): FolderLink | undefined
    {
        const parent = parentOf(file);
        return this.linkedProjects().find((l) => this.projectFolder(l.projectName) === parent);
    }

    /** Turns a new note in a project's folder into a Plane work item, when sending changes is on. */
    async maybeCreate(file: TFile)
    {
        if (
            !this.settings.workItemsEnabled || !this.settings.workItemsPush || !this.plugin.configured
            || !file.path.endsWith(".md") || UNTITLED.test(file.basename) || this.creating.has(file.path)
        )
        {
            return;
        }
        const link = this.projectOfNote(file);
        if (!link)
        {
            return;
        }
        const job = this.create(file, link).finally(() => this.creating.delete(file.path));
        this.creating.set(file.path, job);
        await job;
    }

    private async create(file: TFile, link: FolderLink)
    {
        const local = await this.readLocal(file);
        if (local.id || local.skip)
        {
            return;
        }
        const now = Date.now();
        this.createdAt = this.createdAt.filter((t) => now - t < 60_000);
        if (this.createdAt.length >= MAX_CREATES_PER_MINUTE)
        {
            this.tell(
                `Paused making work items: more than ${MAX_CREATES_PER_MINUTE} new notes in a minute. They'll be created on the next sync.`,
                true,
            );
            return;
        }
        this.createdAt.push(now);

        try
        {
            const project = (await this.plugin.getProjects()).find((p) => p.id === link.projectId);
            if (!project)
            {
                throw new Error(`The project "${link.projectName}" no longer exists in Plane.`);
            }
            const states = await this.statesFor(project.id);
            const state = local.state ? findState(states, local.state) : undefined;
            if (local.state && !state)
            {
                this.tell(
                    `“${local.state}” isn't a state in ${project.name}, so the new work item uses the default.`,
                    true,
                );
            }
            const priority = local.priority?.toLowerCase();
            const html = local.body ? markdownToPlaneHtml(local.body, { resolveLink: () => null }) : "";
            const created = await this.plugin.client.createWorkItem(project.id, {
                name: file.basename.trim(),
                ...(html ? { description_html: html } : {}),
                ...(state ? { state: state.id } : {}),
                ...(priority && PRIORITIES.includes(priority) ? { priority } : {}),
                external_source: "obsidian-plane-sync",
                external_id: `${now}-${hash(file.path)}`,
            });
            this.created.set(created.id, file.path);

            // Fill in what Plane may leave out of its reply with what we sent.
            const fallbackState = state ?? states.find((s) => s.default);
            const snap = snapshotOf(
                { ...created, name: created.name || file.basename, state: created.state ?? fallbackState?.id },
                project,
                states,
                this.plugin.appBase(),
                this.settings.workspace,
            );
            const remoteBody = created.description_html != null ? snap.body : local.body;
            await withLock(`wi:${created.id}`, async () =>
            {
                await this.applyProps(file, created.id, { ...snap, body: remoteBody });
                const rec: WorkItemRecord = {
                    project: project.id,
                    rest: restHash(snap),
                    state: snap.state,
                    body: bodyHash(remoteBody),
                    autoName: file.basename,
                };
                this.settings.workItems[created.id] = rec;
                await this.maybeRename(file, rec, snap);
            });
            this.plugin.saveSettings();
            new Notice(`Created ${snap.key} in Plane`, 3000);
        }
        catch (e)
        {
            this.lastError = planeErrorText(e);
            console.error("[plane-sync] creating work item failed", e);
            this.tell(`Couldn't create “${file.basename}” in Plane. ${this.lastError}`, true);
        }
    }

    private groupOf(projectId: string, stateName: string)
    {
        const states = this.states.get(projectId) ?? [];
        return findState(states, stateName)?.group ?? "";
    }

    private async setState(file: TFile, projectId: string, state: string)
    {
        const group = this.groupOf(projectId, state);
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) =>
        {
            fm[FM_STATE] = state;
            if (group)
            {
                fm[FM_GROUP] = group;
            }
        });
    }

    /** At most one message every 30 seconds, so dragging several cards doesn't flood you. */
    private tell(message: string, always = false)
    {
        if (always || Date.now() - this.noticeAt > 30_000)
        {
            this.noticeAt = Date.now();
            new Notice(message, 8000);
        }
    }

    // ---------- the board ----------

    private async ensureBoard(project: PlaneProject, states: PlaneState[], dir: string)
    {
        const path = this.boardPath(project.name);
        const yaml = boardYaml(dir, states);
        const boards = this.settings.workItemBoards;
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (!existing)
        {
            await this.app.vault.create(path, yaml);
            boards[project.id] = { hash: hash(yaml) };
        }
        else if (existing instanceof TFile && boards[project.id])
        {
            // Only refresh the columns while the file is still exactly what we wrote.
            const current = await this.app.vault.read(existing);
            if (hash(current) === boards[project.id].hash && current !== yaml)
            {
                await this.app.vault.process(existing, () => yaml);
                boards[project.id] = { hash: hash(yaml) };
            }
        }
    }

    /** Makes sure the project's notes and board exist, then returns the board file. */
    async boardFor(link: FolderLink): Promise<TFile | null>
    {
        if (!this.app.vault.getAbstractFileByPath(this.boardPath(link.projectName)))
        {
            await this.pull();
        }
        const file = this.app.vault.getAbstractFileByPath(this.boardPath(link.projectName));
        return file instanceof TFile ? file : null;
    }

    // ---------- notes ----------

    private async readLocal(file: TFile): Promise<LocalItem>
    {
        const data = await this.app.vault.read(file);
        const info = getFrontMatterInfo(data);
        const parsed: unknown = info.exists ? parseYaml(info.frontmatter) : {};
        const fm = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
        return {
            id: textOf(fm[FM_ITEM]),
            state: textOf(fm[FM_STATE]),
            priority: textOf(fm[FM_PRIORITY]),
            skip: fm[FM_SKIP] === false || fm[FM_SKIP] === "false",
            body: data.slice(info.exists ? info.contentStart : 0).trim(),
        };
    }

    private props(id: string, s: Snapshot): Record<string, unknown>
    {
        const out: Record<string, unknown> = {
            [FM_ITEM]: id,
            [FM_KEY]: s.key,
            [FM_STATE]: s.state,
            [FM_PRIORITY]: s.priority,
        };
        if (s.group)
        {
            out[FM_GROUP] = s.group;
        }
        if (s.assignees.length)
        {
            out[FM_ASSIGNEES] = s.assignees;
        }
        if (s.labels.length)
        {
            out[FM_LABELS] = s.labels;
        }
        if (s.target)
        {
            out[FM_TARGET] = s.target;
        }
        out[FM_URL] = s.url;
        return out;
    }

    private render(id: string, s: Snapshot)
    {
        const head = stringifyYaml(this.props(id, s)).trimEnd();
        return `---\n${head}\n---\n${s.body ? `${s.body}\n` : ""}`;
    }

    private async applyProps(file: TFile, id: string, s: Snapshot)
    {
        const props = this.props(id, s);
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) =>
        {
            for (const k of [FM_GROUP, FM_ASSIGNEES, FM_LABELS, FM_TARGET])
            {
                if (!(k in props))
                {
                    delete fm[k];
                }
            }
            Object.assign(fm, props);
        });
    }

    private async writeBody(file: TFile, body: string)
    {
        await this.app.vault.process(file, (data) =>
        {
            const info = getFrontMatterInfo(data);
            const head = info.exists ? data.slice(0, info.contentStart) : "";
            return `${head}${head && !head.endsWith("\n") ? "\n" : ""}${body ? `${body}\n` : ""}`;
        });
    }

    private async saveConflictCopy(s: Snapshot, body: string)
    {
        await this.ensureFolder(this.conflictsFolder);
        const path = await this.uniquePath(this.conflictsFolder, `${s.key} ${safeName(s.title, 50)} (${stamp()})`);
        await this.app.vault.create(path, `${body.trim()}\n`);
    }

    private async maybeRename(file: TFile, rec: WorkItemRecord, s: Snapshot)
    {
        const want = `${s.key} ${safeName(s.title)}`;
        if (file.basename !== rec.autoName || want === rec.autoName)
        {
            return;
        }
        const dir = file.parent?.path ?? this.folder;
        const path = await this.uniquePath(dir, want);
        rec.autoName = path.slice(path.lastIndexOf("/") + 1, -3);
        await this.app.fileManager.renameFile(file, path);
    }

    /** Every work item note in the folder, found by the id in its properties. */
    private index(): Map<string, TFile>
    {
        const out = new Map<string, TFile>();
        for (const f of this.app.vault.getMarkdownFiles())
        {
            if (!this.isWorkItemFile(f))
            {
                continue;
            }
            const fm: Record<string, unknown> = this.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
            const id = fm[FM_ITEM];
            if (typeof id === "string" && id && !out.has(id))
            {
                out.set(id, f);
            }
        }
        // Notes made a moment ago may not be in the metadata cache yet.
        for (const [id, path] of this.created)
        {
            if (out.has(id))
            {
                continue;
            }
            const f = this.app.vault.getAbstractFileByPath(path);
            if (f instanceof TFile)
            {
                out.set(id, f);
            }
            else
            {
                this.created.delete(id);
            }
        }
        return out;
    }

    private async ensureFolder(dir: string)
    {
        if (!this.app.vault.getFolderByPath(dir))
        {
            await this.app.vault.createFolder(dir);
        }
    }

    private async uniquePath(dir: string, title: string)
    {
        await this.ensureFolder(dir);
        let path = normalizePath(`${dir}/${title}.md`);
        for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++)
        {
            path = normalizePath(`${dir}/${title} ${i}.md`);
        }
        return path;
    }
}
