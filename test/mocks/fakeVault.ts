// A tiny in-memory vault for the headless sync tests.
import { getFrontMatterInfo, parseYaml, TFile } from "obsidian";

export class FakeVault
{
    files = new Map<string, { content: string; mtime: number; }>();
    writes = 0;
    clock = 1_000;
    private objs = new Map<string, TFile>();
    tick()
    {
        return ++this.clock;
    }
    file(path: string)
    {
        const f = this.files.get(path);
        if (!f)
        {
            return null;
        }
        let o = this.objs.get(path);
        if (!o)
        {
            o = new TFile(path, { mtime: f.mtime });
            this.objs.set(path, o);
        }
        o.stat.mtime = f.mtime;
        return o;
    }
    getMarkdownFiles()
    {
        return [...this.files.keys()].map((p) => this.file(p)!);
    }
    getFileByPath(p: string)
    {
        return this.file(p);
    }
    getAbstractFileByPath(p: string)
    {
        return this.file(p);
    }
    getFolderByPath()
    {
        return {};
    }
    async createFolder()
    {
    }
    async read(f: TFile)
    {
        return this.files.get(f.path)!.content;
    }
    async create(path: string, content: string)
    {
        this.files.set(path, { content, mtime: this.tick() });
        this.writes++;
        return this.file(path)!;
    }
    async process(f: TFile, fn: (d: string) => string)
    {
        const cur = this.files.get(f.path)!;
        const next = fn(cur.content);
        if (next !== cur.content)
        {
            this.files.set(f.path, { content: next, mtime: this.tick() });
            this.writes++;
        }
    }
    edit(path: string, body: string)
    {
        const cur = this.files.get(path)!;
        const info = getFrontMatterInfo(cur.content);
        this.files.set(path, { content: `${cur.content.slice(0, info.contentStart) + body}\n`, mtime: this.tick() });
    }
    body(path: string)
    {
        const c = this.files.get(path)!.content;
        return c.slice(getFrontMatterInfo(c).contentStart).trim();
    }
    fm(path: string)
    {
        const c = this.files.get(path)!.content;
        return parseYaml(getFrontMatterInfo(c).frontmatter);
    }
}
