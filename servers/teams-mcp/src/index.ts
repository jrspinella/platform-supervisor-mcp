import "dotenv/config";
import { z } from "zod";
import { startMcpHttpServer } from "mcp-http";
import { makeGraphClient } from "auth/src/graph.js";


const PORT = Number(process.env.PORT ?? 8713);


const TENANT_ID = process.env.TEAMS_TENANT_ID || process.env.AZURE_TENANT_ID!;
const CLIENT_ID = process.env.TEAMS_CLIENT_ID!; // App registration for Graph
const CLIENT_SECRET = process.env.TEAMS_CLIENT_SECRET!;


const graph = makeGraphClient({
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    cloud: (process.env.MSFT_CLOUD as any) || "Public",
});


// Helpers
async function pagedGet(path: string) {
    const first = await graph.api(path).get();
    const items = [...(first.value ?? [])];
    let next = first["@odata.nextLink"] as string | undefined;
    while (next) {
        const page = await graph.api(next).get();
        items.push(...(page.value ?? []));
        next = page["@odata.nextLink"];
    }
    return items;
}

const tools = [
{
    name: "teams.list_teams",
    description: "List teams in the tenant (requires Team.ReadBasic.All app permission).",
    inputSchema: z.object({}).strict(),
    handler: async () => {
        // /teams supports app perms with Team.ReadBasic.All
        const items = await pagedGet("/teams");
        return { content: [{ type: "json" as const, json: items }] };
    },
},
// List channels in a team
{
    name: "teams.list_channels",
        description: "List channels for a given team (requires Channel.ReadBasic.All app permission).",
            inputSchema: z.object({ teamId: z.string() }),
                handler: async ({ teamId }: { teamId: string }) => {
                    const items = await pagedGet(`/teams/${teamId}/channels`);
                    return { content: [{ type: "json" as const, json: items }] };
                },
},
// Create channel
{
    name: "teams.create_channel",
        description: "Create a channel in a team. Prefer RSC Channel.Create.Group or use Channel.Create app permission.",
            inputSchema: z.object({
                teamId: z.string(),
                displayName: z.string(),
                description: z.string().default(""),
                membershipType: z.enum(["standard", "private", "shared"]).default("standard"),
            }),
                handler: async ({ teamId, displayName, description, membershipType }: { teamId: string, displayName: string, description: string, membershipType: string }) => {
                    const body: any = { displayName, description, membershipType };
                    const created = await graph.api(`/teams/${teamId}/channels`).post(body);
                    return { content: [{ type: "json" as const, json: created }] };
                },
},
// Add member to team
{
    name: "teams.add_member",
        description: "Add a member (by userId or UPN) to a team. App perms: TeamMember.ReadWrite.All (no guest add).",
            inputSchema: z.object({
                teamId: z.string(),
                userIdOrUpn: z.string(),
                role: z.enum(["member", "owner"]).default("member"),
            }),
                handler: async ({ teamId, userIdOrUpn, role }: { teamId: string, userIdOrUpn: string, role: string }) => {
                    const isUpn = userIdOrUpn.includes("@");
                    const userBind = isUpn
                        ? `https://graph.microsoft.com/v1.0/users('${userIdOrUpn}')`
                        : `https://graph.microsoft.com/v1.0/users('${userIdOrUpn}')`;
                    const body = {
                        "@odata.type": "#microsoft.graph.aadUserConversationMember",
                        roles: role === "owner" ? ["owner"] : [],
                        "user@odata.bind": userBind,
                    };
                    const res = await graph.api(`/teams/${teamId}/members`).post(body);
                    return { content: [{ type: "json" as const, json: res }] };
                },
},
// Post a channel message (RSC only)
{
    name: "teams.post_channel_message",
        description: "Post a message into a channel. Requires RSC ChannelMessage.Send.Group and app installed in the team.",
            inputSchema: z.object({
                teamId: z.string(),
                channelId: z.string(),
                content: z.string(),
            }),
                handler: async ({ teamId, channelId, content }: { teamId: string, channelId: string, content: string }) => {
                    const body = { body: { content } };
                    const res = await graph.api(`/teams/${teamId}/channels/${channelId}/messages`).post(body);
                    return { content: [{ type: "json" as const, json: res }] };
                },
},
];


startMcpHttpServer({ name: "teams-mcp", version: "0.1.0", port: PORT, tools });
