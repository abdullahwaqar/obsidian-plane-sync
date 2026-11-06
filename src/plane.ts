import { type RequestUrlResponse, requestUrl } from "obsidian";

export interface PlaneProject
{
    id: string;
    name: string;
    identifier: string;
}

export interface PlaneSticky
{
    id: string;
    name?: string | null;
    description_html?: string | null;
    background_color?: string | null;
    sort_order?: number | null;
    created_at?: string;
    updated_at?: string;
}

export interface StickyInput
{
    description_html?: string;
    description_stripped?: string;
    background_color?: string;
}

export interface PlaneState
{
    id: string;
    name: string;
    group?: string; // backlog | unstarted | started | completed | cancelled
    color?: string;
    sequence?: number;
    default?: boolean;
}

type Person = string | { id?: string; display_name?: string; first_name?: string; last_name?: string; email?: string; };

export interface PlaneWorkItem
{
    id: string;
    name: string;
    sequence_id?: number;
    description_html?: string | null;
    description_stripped?: string | null;
    priority?: string | null;
    // Plane returns the state as an id, or as an object when expanded.
    state?: string | { id?: string; name?: string; group?: string; } | null;
    assignees?: Person[] | null;
    labels?: Array<string | { id?: string; name?: string; }> | null;
    target_date?: string | null;
    updated_at?: string;
    archived_at?: string | null;
    is_draft?: boolean;
}

type Paginated<T> = { results?: T[]; next_page_results?: boolean; next_cursor?: string; } | T[];

export interface PlanePage
{
    id: string;
    name: string;
    description_html?: string;
    is_locked?: boolean;
    archived_at?: string | null;
}

export class PlaneError extends Error
{
    constructor(public status: number, message: string)
    {
        super(message);
    }
}

const MIN_GAP_MS = 1050; // Plane allows 60 req/min per key

/** Thin client for the Plane REST API. All calls go through one serial queue. */
export class PlaneClient
{
    private chain: Promise<unknown> = Promise.resolve();
    private last = 0;
    private itemsSegment = "work-items"; // older self-hosted versions call them "issues"

    constructor(private cfg: () => { apiBase: string; apiKey: string; workspace: string; })
    {}

    private get base()
    {
        const { apiBase, workspace } = this.cfg();
        return `${apiBase.replace(/\/+$/, "")}/api/v1/workspaces/${encodeURIComponent(workspace)}`;
    }

    private request<T>(method: string, path: string, body?: unknown): Promise<T>
    {
        const run = async (): Promise<T> =>
        {
            for (let attempt = 0; attempt < 4; attempt++)
            {
                const wait = this.last + MIN_GAP_MS - Date.now();
                if (wait > 0)
                {
                    await sleep(wait);
                }
                this.last = Date.now();

                const res: RequestUrlResponse = await requestUrl({
                    url: `${this.base}${path}`,
                    method,
                    headers: { "X-API-Key": this.cfg().apiKey, "Content-Type": "application/json" },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    throw: false,
                });

                if (res.status === 429)
                {
                    const reset = Number(res.headers["x-ratelimit-reset"] ?? res.headers["X-RateLimit-Reset"]);
                    await sleep(reset ? Math.max(1000, reset * 1000 - Date.now() + 250) : 5000);
                    continue;
                }
                if (res.status >= 500 && attempt < 3)
                {
                    await sleep(2000 * (attempt + 1));
                    continue;
                }
                if (res.status >= 400)
                {
                    let detail = "";
                    try
                    {
                        detail = JSON.stringify(res.json);
                    }
                    catch
                    {
                        detail = res.text?.slice(0, 200) ?? "";
                    }
                    throw new PlaneError(res.status, `Plane ${method} ${path} -> ${res.status} ${detail}`);
                }
                if (res.status === 204 || !res.text)
                {
                    return undefined as T;
                }
                return res.json as T;
            }
            throw new PlaneError(429, "Plane rate limit: gave up after retries");
        };
        const p = this.chain.then(run, run);
        this.chain = p.catch(() => undefined);
        return p;
    }

    /** Follows Plane's cursor pagination until every result is loaded. */
    private async listAll<T>(path: string): Promise<T[]>
    {
        const out: T[] = [];
        let cursor = "";
        const sep = path.includes("?") ? "&" : "?";
        for (let i = 0; i < 50; i++)
        {
            const res = await this.request<Paginated<T>>(
                "GET",
                `${path}${sep}per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            );
            if (Array.isArray(res))
            {
                return res;
            }
            out.push(...(res.results ?? []));
            if (!res.next_page_results || !res.next_cursor)
            {
                break;
            }
            cursor = res.next_cursor;
        }
        return out;
    }

    listProjects(): Promise<PlaneProject[]>
    {
        return this.listAll<PlaneProject>("/projects/");
    }

    // Stickies belong to the token's owner, so these only ever see your own stickies.

    listStickies(): Promise<PlaneSticky[]>
    {
        return this.listAll<PlaneSticky>("/stickies/");
    }

    createSticky(input: StickyInput)
    {
        return this.request<PlaneSticky>("POST", "/stickies/", input);
    }

    updateSticky(id: string, input: StickyInput)
    {
        return this.request<PlaneSticky>("PATCH", `/stickies/${id}/`, input);
    }

    deleteSticky(id: string)
    {
        return this.request<void>("DELETE", `/stickies/${id}/`);
    }

    listStates(projectId: string): Promise<PlaneState[]>
    {
        return this.listAll<PlaneState>(`/projects/${projectId}/states/`);
    }

    /** Work items with their state, assignees and labels expanded. Falls back for servers that don't support that. */
    async listWorkItems(projectId: string): Promise<PlaneWorkItem[]>
    {
        const path = () => `/projects/${projectId}/${this.itemsSegment}/`;
        try
        {
            return await this.listAll<PlaneWorkItem>(`${path()}?expand=state,assignees,labels`);
        }
        catch (e)
        {
            if (!(e instanceof PlaneError))
            {
                throw e;
            }
            if (e.status === 404 && this.itemsSegment === "work-items")
            {
                this.itemsSegment = "issues";
                return this.listWorkItems(projectId);
            }
            if (e.status === 400)
            {
                return this.listAll<PlaneWorkItem>(path());
            }
            throw e;
        }
    }

    createWorkItem(
        projectId: string,
        input: {
            name: string;
            description_html?: string;
            state?: string;
            priority?: string;
            external_id?: string;
            external_source?: string;
        },
    )
    {
        return this.request<PlaneWorkItem>("POST", `/projects/${projectId}/${this.itemsSegment}/`, input);
    }

    updateWorkItem(projectId: string, workItemId: string, input: { state: string; })
    {
        return this.request<PlaneWorkItem>(
            "PATCH",
            `/projects/${projectId}/${this.itemsSegment}/${workItemId}/`,
            input,
        );
    }

    createPage(projectId: string, name: string, html: string, externalId: string)
    {
        return this.request<PlanePage>("POST", `/projects/${projectId}/pages/`, {
            name,
            description_html: html,
            access: 0,
            external_id: externalId,
            external_source: "obsidian",
        });
    }

    updatePage(projectId: string, pageId: string, name: string, html: string)
    {
        return this.request<PlanePage>("PUT", `/projects/${projectId}/pages/${pageId}/`, {
            name,
            description_html: html,
        });
    }

    getPage(projectId: string, pageId: string)
    {
        return this.request<PlanePage>("GET", `/projects/${projectId}/pages/${pageId}/`);
    }

    archivePage(projectId: string, pageId: string)
    {
        return this.request<void>("POST", `/projects/${projectId}/pages/${pageId}/archive/`);
    }

    restorePage(projectId: string, pageId: string)
    {
        return this.request<void>("DELETE", `/projects/${projectId}/pages/${pageId}/archive/`);
    }
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
