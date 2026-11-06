// Bundled with esbuild (obsidian aliased to test/mocks/obsidian.ts) and run with node --test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getFrontMatterInfo, notices, parseYaml, stringifyYaml, type TFile } from "obsidian";
import { PlaneError, type PlaneProject, type PlaneState, type PlaneWorkItem } from "../src/plane";
import { DEFAULTS, type Settings } from "../src/settings";
import { boardYaml, FM_ITEM, findState, snapshotOf, stateOrder, textOf, WorkItemSync } from "../src/workItems";
import { FakeVault } from "./mocks/fakeVault";

(globalThis as unknown as { window: typeof globalThis; }).window = globalThis;

const PROJECT: PlaneProject = { id: "p1", name: "MSA & Co.", identifier: "MSA" };
const STATES: PlaneState[] = [
    { id: "s-done", name: "Done", group: "completed", sequence: 3 },
    { id: "s-todo", name: "Todo", group: "unstarted", sequence: 2 },
    { id: "s-back", name: "Backlog", group: "backlog", sequence: 1, default: true },
    { id: "s-prog", name: "In Progress", group: "started", sequence: 4 },
];

class FakePlane
{
    items = new Map<string, PlaneWorkItem>();
    calls: string[] = [];
    failUpdates = false;
    updateStatus = 500;
    createDelay = 0;
    created: Array<Record<string, unknown>> = [];
    private n = 0;
    async listStates()
    {
        this.calls.push("states");
        return STATES.map((s) => ({ ...s }));
    }
    async listWorkItems()
    {
        this.calls.push("items");
        return [...this.items.values()].map((i) => structuredClone(i));
    }
    async updateWorkItem(_p: string, id: string, input: { state: string; })
    {
        this.calls.push(`update ${id} ${input.state}`);
        if (this.failUpdates)
        {
            throw new PlaneError(this.updateStatus, "boom");
        }
        this.items.get(id)!.state = input.state;
    }
    async createWorkItem(_p: string, input: Record<string, unknown>)
    {
        this.calls.push(`create ${String(input.name)}`);
        this.created.push(input);
        // Like Plane: the state comes back as an id, and the default state is used when none is sent.
        const item = this.add({
            name: String(input.name),
            description_html: (input.description_html as string | undefined) ?? "<p></p>",
            state: (input.state as string | undefined) ?? "s-back",
            priority: (input.priority as string | undefined) ?? "none",
            assignees: [],
            labels: [],
        });
        // The item already shows up in lists while the reply is still on its way.
        if (this.createDelay)
        {
            await new Promise((r) => setTimeout(r, this.createDelay));
        }
        return structuredClone(item);
    }
    add(over: Partial<PlaneWorkItem> = {})
    {
        const seq = ++this.n;
        const item: PlaneWorkItem = {
            id: `w${seq}`,
            name: `Item ${seq}`,
            sequence_id: seq,
            description_html: "<p>Hello</p>",
            priority: "medium",
            state: { id: "s-todo", name: "Todo", group: "unstarted" },
            assignees: [{ display_name: "Abdullah" }],
            labels: [{ name: "bug" }],
            ...over,
        };
        this.items.set(item.id, item);
        return item;
    }
}

function setup(over: Partial<Settings> = {})
{
    const vault = new FakeVault();
    const plane = new FakePlane();
    const settings: Settings = structuredClone(DEFAULTS);
    settings.workItemsEnabled = true;
    settings.workspace = "labvent";
    settings.links = { "Plane/MSA": { projectId: "p1", projectName: "MSA & Co." } };
    Object.assign(settings, over);
    let cacheLag = false;
    const app = {
        vault,
        metadataCache: {
            getFileCache: (f: TFile) =>
            {
                if (cacheLag)
                {
                    return null;
                }
                const c = vault.files.get(f.path)?.content ?? "";
                return { frontmatter: parseYaml(getFrontMatterInfo(c).frontmatter) };
            },
        },
        fileManager: {
            processFrontMatter: async (f: TFile, fn: (fm: Record<string, unknown>) => void) =>
            {
                await vault.process(f, (data) =>
                {
                    const info = getFrontMatterInfo(data);
                    const fm = info.exists ? parseYaml(info.frontmatter) : {};
                    fn(fm);
                    return `---\n${stringifyYaml(fm)}\n---\n${data.slice(info.contentStart)}`;
                });
            },
            renameFile: async (f: TFile, to: string) =>
            {
                const cur = vault.files.get(f.path)!;
                vault.files.delete(f.path);
                vault.files.set(to, cur);
                f.path = to;
            },
        },
    };
    const plugin = {
        app,
        settings,
        configured: true,
        client: plane,
        saveSettings: () => undefined,
        appBase: () => "https://app.plane.so",
        getProjects: async () => [PROJECT],
    };
    const sync = new WorkItemSync(plugin as never);
    const noteFor = (id: string) =>
        [...vault.files.keys()].find((p) =>
        {
            const fm = vault.fm(p);
            return fm[FM_ITEM] === id;
        });
    return { vault, plane, settings, sync, noteFor, lag: (v: boolean) => (cacheLag = v) };
}

const DIR = "Plane Work Items/MSA & Co.";

test("a pull makes one note per work item and a board with columns in Plane's order", async () =>
{
    const { plane, vault, sync, noteFor } = setup();
    const a = plane.add({ name: "Launch plan", description_html: "<p>Ship <strong>it</strong></p>" });
    await sync.pull();
    const path = noteFor(a.id)!;
    assert.equal(path, `${DIR}/MSA-1 Launch plan.md`);
    assert.equal(vault.body(path), "Ship **it**");
    const fm = vault.fm(path);
    assert.equal(fm.plane_state, "Todo");
    assert.equal(fm.plane_state_group, "unstarted");
    assert.equal(fm.plane_priority, "medium");
    assert.equal(fm.plane_key, "MSA-1");
    assert.equal(fm.plane_url, "https://app.plane.so/labvent/browse/MSA-1/");
    const board = vault.files.get(`${DIR}/Board.base`)!.content;
    assert.match(board, /type: kanban/);
    assert.match(board, /property: note\.plane_state/);
    const cols = [...board.matchAll(/^ {6}- "(.+)"$/gm)].map((m) => m[1]);
    assert.deepEqual(cols, ["Backlog", "Todo", "In Progress", "Done"]);
});

test("pulling twice with no changes writes nothing", async () =>
{
    const { plane, vault, sync } = setup();
    plane.add();
    plane.add();
    await sync.pull();
    const writes = vault.writes;
    await sync.pull();
    assert.equal(vault.writes, writes);
});

test("changes made in Plane update the note, and the file follows a new title", async () =>
{
    const { plane, vault, sync, noteFor } = setup();
    const a = plane.add({ name: "Old title" });
    await sync.pull();
    Object.assign(a, {
        name: "New title",
        priority: "urgent",
        description_html: "<p>Rewritten</p>",
        state: { id: "s-prog", name: "In Progress", group: "started" },
    });
    await sync.pull();
    const path = noteFor(a.id)!;
    assert.equal(path, `${DIR}/MSA-1 New title.md`);
    assert.equal(vault.body(path), "Rewritten");
    assert.equal(vault.fm(path).plane_state, "In Progress");
    assert.equal(vault.fm(path).plane_priority, "urgent");
});

test("a note you renamed yourself keeps its name", async () =>
{
    const { plane, vault, sync, noteFor } = setup();
    const a = plane.add({ name: "Old title" });
    await sync.pull();
    const old = noteFor(a.id)!;
    const mine = `${DIR}/My own name.md`;
    vault.files.set(mine, vault.files.get(old)!);
    vault.files.delete(old);
    a.name = "New title";
    await sync.pull();
    assert.equal(noteFor(a.id), mine);
    assert.equal(vault.fm(mine).plane_key, "MSA-1");
});

test("a card dragged while pushing is off goes back and nothing is sent", async () =>
{
    const { plane, vault, sync, noteFor, settings } = setup();
    const a = plane.add();
    await sync.pull();
    const path = noteFor(a.id)!;
    await vault.process(vault.file(path)!, (d) => d.replace("plane_state: Todo", "plane_state: Done"));
    await sync.syncMove(vault.file(path)!);
    assert.equal(vault.fm(path).plane_state, "Todo");
    assert.ok(!plane.calls.some((c) => c.startsWith("update")));
    assert.equal(settings.workItems[a.id].state, "Todo");
});

test("a card dragged while pushing is on updates the state in Plane", async () =>
{
    const { plane, vault, sync, noteFor, settings } = setup({ workItemsPush: true });
    const a = plane.add();
    await sync.pull();
    const path = noteFor(a.id)!;
    await vault.process(vault.file(path)!, (d) => d.replace("plane_state: Todo", "plane_state: Done"));
    await sync.syncMove(vault.file(path)!);
    assert.ok(plane.calls.includes("update w1 s-done"));
    assert.equal(vault.fm(path).plane_state, "Done");
    assert.equal(vault.fm(path).plane_state_group, "completed");
    assert.equal(settings.workItems[a.id].state, "Done");
    // The next pull sees the same state on both sides and leaves it alone.
    const writes = vault.writes;
    await sync.pull();
    assert.equal(vault.writes, writes);
    assert.equal(vault.fm(path).plane_state, "Done");
});

test("a move picked up during a pull is pushed too", async () =>
{
    const { plane, vault, sync, noteFor } = setup({ workItemsPush: true });
    const a = plane.add();
    await sync.pull();
    const path = noteFor(a.id)!;
    await vault.process(vault.file(path)!, (d) => d.replace("plane_state: Todo", "plane_state: Backlog"));
    await sync.pull();
    assert.ok(plane.calls.includes("update w1 s-back"));
    assert.equal(vault.fm(path).plane_state, "Backlog");
});

test("a state that doesn't exist in Plane, or a failed push, puts the card back", async () =>
{
    const { plane, vault, sync, noteFor } = setup({ workItemsPush: true });
    const a = plane.add();
    await sync.pull();
    const path = noteFor(a.id)!;

    await vault.process(vault.file(path)!, (d) => d.replace("plane_state: Todo", "plane_state: Nope"));
    await sync.syncMove(vault.file(path)!);
    assert.equal(vault.fm(path).plane_state, "Todo");
    assert.ok(!plane.calls.some((c) => c.startsWith("update")));

    plane.failUpdates = true;
    await vault.process(vault.file(path)!, (d) => d.replace("plane_state: Todo", "plane_state: Done"));
    await sync.syncMove(vault.file(path)!);
    assert.equal(vault.fm(path).plane_state, "Todo");
});

test("if the state changed in Plane too, Plane wins over your move", async () =>
{
    const { plane, vault, sync, noteFor } = setup({ workItemsPush: true });
    const a = plane.add();
    await sync.pull();
    const path = noteFor(a.id)!;
    await vault.process(vault.file(path)!, (d) => d.replace("plane_state: Todo", "plane_state: Done"));
    a.state = { id: "s-prog", name: "In Progress", group: "started" };
    await sync.pull();
    assert.equal(vault.fm(path).plane_state, "In Progress");
    assert.ok(!plane.calls.some((c) => c.startsWith("update")));
});

test("your edits to the body are kept until the description changes in Plane, then saved in Conflicts", async () =>
{
    const { plane, vault, sync, noteFor } = setup();
    const a = plane.add({ description_html: "<p>Original</p>" });
    await sync.pull();
    const path = noteFor(a.id)!;
    vault.edit(path, "My notes");
    await sync.pull();
    assert.equal(vault.body(path), "My notes");

    a.description_html = "<p>Plane rewrote this</p>";
    await sync.pull();
    assert.equal(vault.body(path), "Plane rewrote this");
    const copies = [...vault.files.keys()].filter((p) => p.startsWith("Plane Work Items/Conflicts/"));
    assert.equal(copies.length, 1);
    assert.equal(vault.body(copies[0]), "My notes");
    // The conflict copy isn't treated as a work item.
    await sync.pull();
    await sync.pull();
    assert.equal([...vault.files.keys()].filter((p) => p.includes("/Conflicts/")).length, 1);
});

test("archived and draft items are skipped, and many pulls never make duplicates", async () =>
{
    const { plane, vault, sync } = setup();
    plane.add();
    plane.add({ archived_at: "2026-01-01" });
    plane.add({ is_draft: true });
    for (let i = 0; i < 4; i++)
    {
        await sync.pull();
    }
    assert.equal([...vault.files.keys()].filter((p) => p.endsWith(".md")).length, 1);
});

test("duplicates are not made even if Obsidian hasn't indexed the new notes yet", async () =>
{
    const { plane, vault, sync, lag } = setup();
    plane.add();
    plane.add();
    lag(true);
    await sync.pull();
    await sync.pull();
    assert.equal([...vault.files.keys()].filter((p) => p.endsWith(".md")).length, 2);
});

test("if the saved sync data is lost, existing notes are reused and edited text is kept", async () =>
{
    const { plane, vault, sync, settings, noteFor } = setup();
    const a = plane.add({ description_html: "<p>Original</p>" });
    await sync.pull();
    const path = noteFor(a.id)!;
    vault.edit(path, "Text I wrote");
    settings.workItems = {};
    await sync.pull();
    assert.equal([...vault.files.keys()].filter((p) => p.endsWith(".md") && !p.includes("Conflicts")).length, 1);
    assert.equal(vault.body(path), "Original");
    const copies = [...vault.files.keys()].filter((p) => p.includes("/Conflicts/"));
    assert.equal(copies.length, 1);
    assert.equal(vault.body(copies[0]), "Text I wrote");
});

test("the board follows new states only while you haven't edited it", async () =>
{
    const first = setup();
    first.plane.add();
    await first.sync.pull();
    const boardPath = `${DIR}/Board.base`;
    STATES.push({ id: "s-new", name: "Review", group: "started", sequence: 5 });
    try
    {
        await first.sync.pull();
        assert.match(first.vault.files.get(boardPath)!.content, /"Review"/);

        first.vault.files.get(boardPath)!.content += "\n# my change\n";
        STATES.push({ id: "s-new2", name: "QA", group: "started", sequence: 6 });
        await first.sync.pull();
        assert.ok(!/"QA"/.test(first.vault.files.get(boardPath)!.content));
        assert.match(first.vault.files.get(boardPath)!.content, /my change/);
    }
    finally
    {
        STATES.length = 4;
    }
});

test("nothing happens when work items are off, or no folder is linked", async () =>
{
    const off = setup({ workItemsEnabled: false });
    off.plane.add();
    await off.sync.pull();
    assert.equal(off.vault.files.size, 0);

    const none = setup({ links: {} });
    none.plane.add();
    await none.sync.pull();
    assert.equal(none.vault.files.size, 0);
    assert.ok(notices.some((n) => n.includes("Link a folder")));
});

test("states may come back as ids, and assignees as ids, without breaking the note", () =>
{
    const snap = snapshotOf(
        {
            id: "x",
            name: "Plain",
            sequence_id: 7,
            state: "s-back",
            assignees: ["3f9a-uuid"],
            labels: ["label-uuid"],
            priority: null,
            description_html: "<p></p>",
            description_stripped: "fallback text",
        },
        PROJECT,
        STATES,
        "https://app.plane.so/",
        "labvent",
    );
    assert.equal(snap.state, "Backlog");
    assert.equal(snap.group, "backlog");
    assert.deepEqual(snap.assignees, []);
    assert.deepEqual(snap.labels, []);
    assert.equal(snap.priority, "none");
    assert.equal(snap.body, "fallback text");
    assert.equal(snap.url, "https://app.plane.so/labvent/browse/MSA-7/");
});

test("the board shows a clean title and a chip row, with readable property names", () =>
{
    const yaml = boardYaml("Plane Work Items/MSA & Co.", STATES);
    assert.match(yaml, /^ {2}title: '.*file\.name\.slice\(plane_key\.length \+ 1\).*'$/m);
    assert.match(yaml, /^ {2}card: 'html\(.*pps-wi.*'$/m);
    assert.match(yaml, /order:\n {6}- formula\.title\n {6}- formula\.card\n/);
    assert.match(yaml, /plane_priority:\n {4}displayName: "Priority"/);
    assert.match(yaml, /formula\.card:\n {4}displayName: ""/);
    assert.match(yaml, /columnWidth: 300/);
    // Every single quote inside the YAML single-quoted formulas is doubled.
    for (const line of yaml.split("\n").filter((l) => /^ {2}(title|card): '/.test(l)))
    {
        const inner = line.slice(line.indexOf("'") + 1, -1);
        assert.ok(!/(^|[^'])'([^']|$)/.test(inner.replace(/''/g, "")), line.slice(0, 40));
    }
});

test("board columns are ordered by group, then sequence, and quoted safely", () =>
{
    assert.deepEqual(stateOrder(STATES).map((s) => s.name), ["Backlog", "Todo", "In Progress", "Done"]);
    const yaml = boardYaml("Plane Work Items/It's: a #test", [{ id: "1", name: 'Needs "review"', group: "started" }]);
    assert.match(yaml, /file\.inFolder\(""\)|file\.inFolder\("Plane Work Items\/It''s: a #test"\)/);
    assert.match(yaml, /- "Needs \\"review\\""/);
});

const notes = (vault: FakeVault) =>
    [...vault.files.keys()].filter((p) => p.endsWith(".md") && !p.includes("/Conflicts/"));

test("a state written in another case, or as a list, is still sent with Plane's name", async () =>
{
    const { plane, vault, sync, noteFor } = setup({ workItemsPush: true });
    const a = plane.add();
    await sync.pull();
    const path = noteFor(a.id)!;
    await vault.process(vault.file(path)!, (d) => d.replace("plane_state: Todo", "plane_state: in progress"));
    await sync.syncMove(vault.file(path)!);
    assert.ok(plane.calls.includes("update w1 s-prog"));
    assert.equal(vault.fm(path).plane_state, "In Progress");
});

test("property values are read as text whether they're text, numbers or lists", () =>
{
    assert.equal(textOf(" Done "), "Done");
    assert.equal(textOf(["Done", "Todo"]), "Done");
    assert.equal(textOf(3), "3");
    assert.equal(textOf(""), undefined);
    assert.equal(textOf([]), undefined);
    assert.equal(textOf(null), undefined);
    assert.equal(findState(STATES, "  in PROGRESS ")?.id, "s-prog");
    assert.equal(findState(STATES, "Nope"), undefined);
});

test("when Plane refuses a move, the card goes back and you're told to check the token", async () =>
{
    const { plane, vault, sync, noteFor } = setup({ workItemsPush: true });
    const a = plane.add();
    await sync.pull();
    plane.failUpdates = true;
    plane.updateStatus = 403;
    const path = noteFor(a.id)!;
    notices.length = 0;
    await vault.process(vault.file(path)!, (d) => d.replace("plane_state: Todo", "plane_state: Done"));
    await sync.syncMove(vault.file(path)!);
    assert.equal(vault.fm(path).plane_state, "Todo");
    assert.ok(notices.some((n) => n.includes("403") && n.includes("token")));
});

test("a new note in a project folder becomes a work item, with its state, priority and text", async () =>
{
    const { plane, vault, sync, settings, noteFor } = setup({ workItemsPush: true });
    plane.add();
    await sync.pull();
    await vault.create(
        `${DIR}/Write the launch email.md`,
        "---\nplane_state: in progress\nplane_priority: High\n---\nDraft **today**\n",
    );
    await sync.syncMove(vault.file(`${DIR}/Write the launch email.md`)!);

    assert.equal(plane.created.length, 1);
    const sent = plane.created[0];
    assert.equal(sent.name, "Write the launch email");
    assert.equal(sent.state, "s-prog");
    assert.equal(sent.priority, "high");
    assert.match(String(sent.description_html), /<strong>today<\/strong>/);

    const id = [...plane.items.values()].find((i) => i.name === "Write the launch email")!.id;
    const path = noteFor(id)!;
    assert.equal(path, `${DIR}/MSA-2 Write the launch email.md`);
    assert.equal(vault.fm(path).plane_state, "In Progress");
    assert.equal(vault.fm(path).plane_key, "MSA-2");
    assert.equal(vault.body(path), "Draft **today**");
    assert.ok(settings.workItems[id]);

    // Later pulls don't make a second note or a second work item, and keep the text.
    await sync.pull();
    await sync.pull();
    assert.equal(plane.created.length, 1);
    assert.equal(notes(vault).length, 2);
    assert.equal(vault.body(path), "Draft **today**");
});

test("a new note without a state gets the project's default state", async () =>
{
    const { plane, vault, sync, noteFor } = setup({ workItemsPush: true });
    await sync.pull();
    await vault.create(`${DIR}/Quick idea.md`, "");
    await sync.syncMove(vault.file(`${DIR}/Quick idea.md`)!);
    assert.equal(plane.created.length, 1);
    assert.equal(plane.created[0].state, undefined);
    const id = [...plane.items.values()][0].id;
    assert.equal(vault.fm(noteFor(id)!).plane_state, "Backlog");
});

test("Untitled notes wait until you name them", async () =>
{
    const { plane, vault, sync } = setup({ workItemsPush: true });
    await sync.pull();
    await vault.create(`${DIR}/Untitled.md`, "");
    await vault.create(`${DIR}/Untitled 2.md`, "");
    await sync.syncMove(vault.file(`${DIR}/Untitled.md`)!);
    await sync.pull();
    assert.equal(plane.created.length, 0);

    const f = vault.file(`${DIR}/Untitled.md`)!;
    vault.files.set(`${DIR}/Call the printer.md`, vault.files.get(f.path)!);
    vault.files.delete(f.path);
    await sync.syncMove(vault.file(`${DIR}/Call the printer.md`)!);
    assert.deepEqual(plane.created.map((c) => c.name), ["Call the printer"]);
});

test("nothing is created while sending is off, or for notes that aren't in a project folder", async () =>
{
    const off = setup();
    await off.sync.pull();
    await off.vault.create(`${DIR}/Local only.md`, "");
    await off.sync.syncMove(off.vault.file(`${DIR}/Local only.md`)!);
    await off.sync.pull();
    assert.equal(off.plane.created.length, 0);

    const on = setup({ workItemsPush: true });
    await on.sync.pull();
    for (const path of ["Plane Work Items/Conflicts/x.md", "Plane Work Items/loose.md", `${DIR}/sub/deep.md`])
    {
        await on.vault.create(path, "");
        await on.sync.syncMove(on.vault.file(path)!);
    }
    await on.vault.create(`${DIR}/Skip me.md`, "---\nplane_sync: false\n---\n");
    await on.sync.syncMove(on.vault.file(`${DIR}/Skip me.md`)!);
    await on.sync.pull();
    assert.equal(on.plane.created.length, 0);
});

test("notes made while sending was off are created on the first pull after turning it on", async () =>
{
    const { plane, vault, sync, settings } = setup();
    await sync.pull();
    await vault.create(`${DIR}/Made offline.md`, "");
    await sync.pull();
    assert.equal(plane.created.length, 0);
    settings.workItemsPush = true;
    await sync.pull();
    assert.deepEqual(plane.created.map((c) => c.name), ["Made offline"]);
    await sync.pull();
    assert.equal(plane.created.length, 1);
});

test("creating is capped at 10 a minute", async () =>
{
    const { plane, vault, sync } = setup({ workItemsPush: true });
    await sync.pull();
    for (let i = 1; i <= 12; i++)
    {
        await vault.create(`${DIR}/Task ${i}.md`, "");
        await sync.syncMove(vault.file(`${DIR}/Task ${i}.md`)!);
    }
    assert.equal(plane.created.length, 10);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try
    {
        await sync.pull();
    }
    finally
    {
        Date.now = realNow;
    }
    assert.equal(plane.created.length, 12);
});

test("a pull running while a note is being created doesn't make a second note", async () =>
{
    const { plane, vault, sync } = setup({ workItemsPush: true });
    await sync.pull();
    plane.createDelay = 30;
    await vault.create(`${DIR}/Racing.md`, "");
    const creating = sync.syncMove(vault.file(`${DIR}/Racing.md`)!);
    await new Promise((r) => setTimeout(r, 5));
    const pulling = sync.pull();
    await Promise.all([creating, pulling]);
    await sync.pull();
    assert.equal(plane.created.length, 1);
    assert.equal(notes(vault).length, 1);
});
