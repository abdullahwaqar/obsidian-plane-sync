import { type App, FuzzySuggestModal, PluginSettingTab, type SettingDefinitionItem, type TFolder } from "obsidian";
import type PlanePagesSync from "./main";

export interface FolderLink
{
    projectId: string;
    projectName: string;
}

export interface PageRecord
{
    pageId: string;
    projectId: string;
    hash: string;
}

export interface StickyRecord
{
    path: string;
    localHash: string; // note content at the last sync
    remoteHash: string; // Plane content at the last sync
    autoName?: string; // file name we generated; renamed with the first line until the user renames it
}

export interface WorkItemRecord
{
    project: string; // project id
    rest: string; // hash of everything Plane sent except the state
    state: string; // state name at the last sync (what Plane has, as far as we know)
    body: string; // hash of the description at the last sync
    autoName?: string; // file name we generated; renamed with the title until the user renames it
}

export interface Settings
{
    tokenSecret: string; // name of the secret in Obsidian's secret storage, never the token itself
    workspace: string;
    selfHosted: boolean;
    instanceUrl: string;
    rootFolder: string;
    autoPush: boolean;
    debounceSec: number;
    onDelete: "archive" | "keep";
    links: Record<string, FolderLink>; // folder path -> project
    pages: Record<string, PageRecord>; // file path -> last pushed state
    stickiesEnabled: boolean;
    stickiesFolder: string;
    stickyPullMinutes: number;
    stickies: Record<string, StickyRecord>; // sticky id -> sync state
    workItemsEnabled: boolean;
    workItemsFolder: string;
    workItemsPush: boolean;
    workItemPullMinutes: number;
    workItems: Record<string, WorkItemRecord>; // work item id -> sync state
    workItemBoards: Record<string, { hash: string; }>; // project id -> hash of the board file we wrote
}

export const PLANE_CLOUD_API = "https://api.plane.so";
const LEGACY_TOKEN_SECRET = "plane-pages-sync-token";
const CONNECTION_KEYS = new Set<string>(["tokenSecret", "workspace", "selfHosted", "instanceUrl"]);

export const DEFAULTS: Settings = {
    tokenSecret: "",
    workspace: "",
    selfHosted: false,
    instanceUrl: "",
    rootFolder: "Plane",
    autoPush: true,
    debounceSec: 5,
    onDelete: "archive",
    links: {},
    pages: {},
    stickiesEnabled: true,
    stickiesFolder: "Plane/Stickies",
    stickyPullMinutes: 2,
    stickies: {},
    workItemsEnabled: false,
    workItemsFolder: "Plane Work Items",
    workItemsPush: false,
    workItemPullMinutes: 5,
    workItems: {},
    workItemBoards: {},
};

interface LegacySettings
{
    apiKey?: string;
    apiBase?: string;
    appBase?: string;
}

/** Merges stored data with defaults and migrates settings from 0.1.x. */
export function loadSettings(app: App, raw: unknown): { settings: Settings; migrated: boolean; }
{
    const stored = (raw ?? {}) as Partial<Settings> & LegacySettings;
    const { apiKey, apiBase, appBase: _appBase, ...rest } = stored;
    const settings: Settings = {
        ...DEFAULTS,
        ...rest,
        links: { ...rest.links },
        pages: { ...rest.pages },
        stickies: { ...rest.stickies },
        workItems: { ...rest.workItems },
        workItemBoards: { ...rest.workItemBoards },
    };
    let migrated = false;

    // 0.1.x kept the token in data.json. Move it into secret storage.
    if (apiKey && !settings.tokenSecret)
    {
        app.secretStorage.setSecret(LEGACY_TOKEN_SECRET, apiKey);
        settings.tokenSecret = LEGACY_TOKEN_SECRET;
        migrated = true;
    }
    if (apiBase !== undefined)
    {
        if (apiBase && apiBase !== PLANE_CLOUD_API)
        {
            settings.selfHosted = true;
            settings.instanceUrl = normalizeUrl(apiBase);
        }
        migrated = true;
    }
    return { settings, migrated: migrated || _appBase !== undefined };
}

/** Accepts a bare slug or a pasted Plane URL like https://app.plane.so/labvent/projects/... */
export function parseWorkspace(input: string): string
{
    const value = input.trim();
    const match = /^https?:\/\/[^/]+\/([^/?#]+)/.exec(value);
    return (match ? match[1] : value).replace(/^\/+|\/+$/g, "");
}

export function normalizeUrl(input: string): string
{
    const value = input.trim().replace(/\/+$/, "");
    if (!value)
    {
        return "";
    }
    return /^https?:\/\//.test(value) ? value : `https://${value}`;
}

export class PlaneSettingTab extends PluginSettingTab
{
    private connectionStatus = "";

    constructor(app: App, private plugin: PlanePagesSync)
    {
        super(app, plugin);
    }

    getControlValue(key: string): unknown
    {
        return this.plugin.settings[key as keyof Settings];
    }

    async setControlValue(key: string, value: unknown): Promise<void>
    {
        const s = this.plugin.settings as unknown as Record<string, unknown>;
        if (key === "workspace" && typeof value === "string")
        {
            value = parseWorkspace(value);
        }
        if (key === "instanceUrl" && typeof value === "string")
        {
            value = normalizeUrl(value);
        }
        if (key === "rootFolder" && typeof value === "string")
        {
            value = value.trim().replace(/\/+$/, "");
        }
        s[key] = value;
        if (CONNECTION_KEYS.has(key))
        {
            this.connectionStatus = "";
            this.plugin.resetConnection();
        }
        if (key === "stickiesFolder" && typeof value === "string")
        {
            s[key] = value.trim().replace(/\/+$/, "");
        }
        await this.plugin.saveData(this.plugin.settings);
        if (key === "stickyPullMinutes")
        {
            this.plugin.restartStickyTimer();
        }
        if (key === "workItemsFolder" && typeof value === "string")
        {
            s[key] = value.trim().replace(/\/+$/, "");
        }
        if (key === "workItemPullMinutes")
        {
            this.plugin.restartWorkItemTimer();
        }
        if ((key === "workItemsEnabled" && value === true) || key === "workItemsFolder")
        {
            void this.plugin.workItems.pull();
        }
        if ((key === "stickiesEnabled" && value === true) || key === "stickiesFolder")
        {
            void this.plugin.stickies.pull({ quiet: true });
        }
        if (CONNECTION_KEYS.has(key))
        {
            this.update();
        }
    }

    getSettingDefinitions(): SettingDefinitionItem[]
    {
        const s = this.plugin.settings;
        const notConfigured = () => !this.plugin.configured;
        const links = Object.entries(s.links).sort(([a], [b]) => a.localeCompare(b));
        const synced = Object.keys(s.pages).length;

        return [
            // The first group has no heading, per Obsidian's settings guidelines.
            {
                type: "group",
                items: [
                    {
                        name: "Personal access token",
                        desc:
                            "Create one in Plane under Profile settings → Personal access tokens. It's kept in Obsidian's secret storage, not in the plugin's data file.",
                        aliases: ["api key", "token"],
                        control: { type: "secret", key: "tokenSecret" },
                    },
                    {
                        name: "Workspace",
                        desc:
                            "The workspace slug from your Plane links. You can also paste any link from that workspace.",
                        aliases: ["slug"],
                        control: {
                            type: "text",
                            key: "workspace",
                            placeholder: "my-team",
                            validate: (v) => /\s/.test(v.trim()) ? "Workspace slugs don't contain spaces." : undefined,
                        },
                    },
                    {
                        name: "Self-hosted Plane",
                        desc: "Turn on if your workspace isn't on app.plane.so.",
                        control: { type: "toggle", key: "selfHosted" },
                    },
                    {
                        name: "Instance URL",
                        desc: "The address you open Plane at.",
                        visible: () => s.selfHosted,
                        control: {
                            type: "text",
                            key: "instanceUrl",
                            placeholder: "https://plane.example.com",
                            validate: (v) =>
                                v && !/^(https?:\/\/)?[^\s/]+\.[^\s]+$/.test(v.trim())
                                    ? "Enter a full address."
                                    : undefined,
                        },
                    },
                    {
                        name: "Connection",
                        desc: this.connectionStatus
                            || (this.plugin.configured ? "Not checked yet." : "Add a token and workspace first."),
                        searchable: false,
                        render: (setting) =>
                        {
                            setting.addButton((button) =>
                                button
                                    .setButtonText("Check connection")
                                    .setDisabled(notConfigured())
                                    .onClick(() => void this.checkConnection())
                            );
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Folders",
                items: [
                    {
                        name: "Projects folder",
                        desc:
                            "Folders inside this one link to the Plane project with the same name or identifier, so Plane/Clearline Books syncs to “Clearline Books”. Leave empty to only use folders you link yourself.",
                        aliases: ["root folder"],
                        control: { type: "folder", key: "rootFolder", placeholder: "Plane" },
                    },
                ],
            },
            {
                type: "list",
                heading: "Linked folders",
                emptyState:
                    "No folders linked yet. Add one here, right-click a folder in the file explorer, or create one inside the projects folder.",
                addItem: { name: "Link a folder", action: () => this.linkNewFolder() },
                onDelete: (index) => void this.unlink(links[index]?.[0]),
                items: links.map(([path, link]) => ({
                    name: path,
                    desc: this.app.vault.getFolderByPath(path)
                        ? `→ ${link.projectName}`
                        : `→ ${link.projectName} (folder no longer exists)`,
                    searchable: false,
                    action: () => this.changeProject(path),
                })),
            },
            {
                type: "group",
                heading: "Syncing",
                items: [
                    {
                        name: "Sync on save",
                        desc:
                            "Push a note to Plane shortly after you stop editing it. Turn off to only push with commands.",
                        aliases: ["auto push", "automatic"],
                        control: { type: "toggle", key: "autoPush" },
                    },
                    {
                        name: "Wait before pushing",
                        desc: "Seconds of inactivity before a changed note is pushed.",
                        aliases: ["delay", "debounce"],
                        control: {
                            type: "slider",
                            key: "debounceSec",
                            min: 2,
                            max: 60,
                            step: 1,
                            displayFormat: (v: number) => `${v}s`,
                            disabled: () => !s.autoPush,
                        },
                    },
                    {
                        name: "Deleted notes",
                        desc: "What happens to the Plane page when you delete its note.",
                        control: {
                            type: "dropdown",
                            key: "onDelete",
                            options: { archive: "Archive the page", keep: "Keep the page" },
                        },
                    },
                    {
                        name: "Push everything now",
                        desc: `${synced} note${synced === 1 ? "" : "s"} synced so far. Unchanged notes are skipped.`,
                        render: (setting) =>
                        {
                            setting.addButton((button) =>
                                button
                                    .setButtonText("Push all")
                                    .setDisabled(notConfigured())
                                    .onClick(() =>
                                    {
                                        button.setDisabled(true);
                                        void this.plugin.pushAll().finally(() => this.update());
                                    })
                            );
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Stickies",
                items: [
                    {
                        name: "Sync stickies",
                        desc:
                            "Keep your Plane stickies and a folder of notes in sync, both ways. Plane only shows each person their own stickies.",
                        aliases: ["sticky notes"],
                        control: { type: "toggle", key: "stickiesEnabled" },
                    },
                    {
                        name: "Stickies folder",
                        desc: "Each sticky is a note in this folder. New notes here become new stickies.",
                        control: {
                            disabled: () => !s.stickiesEnabled,
                            type: "folder",
                            key: "stickiesFolder",
                            placeholder: "Plane/Stickies",
                            validate: (v) => v.trim() ? undefined : "Choose a folder for your stickies.",
                        },
                    },
                    {
                        name: "Check Plane for changes",
                        desc:
                            "How often to fetch stickies edited in Plane. Obsidian also checks when you switch back to it.",
                        aliases: ["interval", "pull"],
                        control: {
                            type: "slider",
                            key: "stickyPullMinutes",
                            min: 1,
                            max: 30,
                            step: 1,
                            displayFormat: (v: number) => (v === 1 ? "every minute" : `every ${v} min`),
                            disabled: () => !s.stickiesEnabled,
                        },
                    },
                    {
                        name: "Clean up duplicates",
                        desc:
                            "Find copies left by a sync problem and remove them from Plane and your vault. You'll see what will be removed first.",
                        render: (setting) =>
                        {
                            setting.addButton((button) =>
                                button
                                    .setButtonText("Find duplicates")
                                    .setDisabled(!this.plugin.configured)
                                    .onClick(() => void this.plugin.cleanUpStickies())
                            );
                        },
                    },
                    {
                        name: "Sticky board",
                        desc: "A panel of your stickies you can write in, recolour and delete.",
                        render: (setting) =>
                        {
                            setting.addButton((button) =>
                                button
                                    .setButtonText("Open board")
                                    .setDisabled(!s.stickiesEnabled)
                                    .onClick(() => void this.plugin.openStickyBoard())
                            );
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Work items",
                items: [
                    {
                        name: "Sync work items",
                        desc:
                            "Bring the work items of every linked project into your vault as notes, with a kanban board per project. Boards need Obsidian 1.14 or later.",
                        aliases: ["issues", "kanban", "tasks"],
                        control: { type: "toggle", key: "workItemsEnabled" },
                    },
                    {
                        name: "Work items folder",
                        desc: "Each project gets a subfolder here with one note per work item and its Board file.",
                        control: {
                            disabled: () => !s.workItemsEnabled,
                            type: "folder",
                            key: "workItemsFolder",
                            placeholder: "Plane Work Items",
                            validate: (v) => v.trim() ? undefined : "Choose a folder for your work items.",
                        },
                    },
                    {
                        name: "Send changes to Plane",
                        desc:
                            "Moving a card (or changing plane_state) changes the work item's state in Plane, and a new note in a project's folder becomes a new work item. Off: moves are put back and new notes stay local. Titles, descriptions and other fields of existing work items stay read-only.",
                        aliases: ["write", "two-way", "push board moves", "create"],
                        control: { type: "toggle", key: "workItemsPush", disabled: () => !s.workItemsEnabled },
                    },
                    {
                        name: "Check Plane for changes",
                        desc: "How often to fetch work items changed in Plane.",
                        aliases: ["interval", "pull"],
                        control: {
                            type: "slider",
                            key: "workItemPullMinutes",
                            min: 1,
                            max: 60,
                            step: 1,
                            displayFormat: (v: number) => (v === 1 ? "every minute" : `every ${v} min`),
                            disabled: () => !s.workItemsEnabled,
                        },
                    },
                    {
                        name: "Board",
                        desc: "Open the kanban board for a linked project.",
                        render: (setting) =>
                        {
                            setting.addButton((button) =>
                                button
                                    .setButtonText("Open board")
                                    .setDisabled(!s.workItemsEnabled || !this.plugin.configured)
                                    .onClick(() => void this.plugin.openBoard())
                            );
                        },
                    },
                ],
            },
        ];
    }

    private async checkConnection()
    {
        try
        {
            const projects = await this.plugin.getProjects(true);
            const count = `${projects.length} project${projects.length === 1 ? "" : "s"}`;
            this.connectionStatus = `✓ Connected to “${this.plugin.settings.workspace}”, ${count} found.`;
        }
        catch (error)
        {
            this.connectionStatus = `✗ ${describeError(error)}`;
        }
        this.update();
    }

    private linkNewFolder()
    {
        if (!this.plugin.configured)
        {
            this.connectionStatus = "Add a token and workspace before linking folders.";
            this.update();
            return;
        }
        new FolderPickerModal(this.app, (folder) =>
            this.plugin.pickProject((project) =>
            {
                this.plugin.linkFolder(folder, project);
                this.update();
            })).open();
    }

    private changeProject(path: string)
    {
        const folder = this.app.vault.getFolderByPath(path);
        if (!folder)
        {
            return;
        }
        this.plugin.pickProject((project) =>
        {
            this.plugin.linkFolder(folder, project);
            this.update();
        });
    }

    private async unlink(path: string | undefined)
    {
        if (path)
        {
            delete this.plugin.settings.links[path];
            await this.plugin.saveData(this.plugin.settings);
        }
        this.update();
    }
}

function describeError(error: unknown): string
{
    const status = (error as { status?: number; } | null)?.status;
    if (status === 401 || status === 403)
    {
        return "Plane rejected the token. Check that it's correct and hasn't expired.";
    }
    if (status === 404)
    {
        return "Workspace not found. Check the slug, or the instance URL if you're self-hosted.";
    }
    return error instanceof Error ? error.message : String(error);
}

class FolderPickerModal extends FuzzySuggestModal<TFolder>
{
    constructor(app: App, private onPick: (folder: TFolder) => void)
    {
        super(app);
        this.setPlaceholder("Pick a folder to link");
    }

    getItems(): TFolder[]
    {
        return this.app.vault.getAllFolders(false);
    }

    getItemText(folder: TFolder)
    {
        return folder.path;
    }

    onChooseItem(folder: TFolder)
    {
        this.onPick(folder);
    }
}
