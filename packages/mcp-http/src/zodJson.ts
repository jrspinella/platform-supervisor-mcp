import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";


export type ZSchema = ReturnType<typeof z.object>;
export function toJSONSchema(schema: any) {
return zodToJsonSchema(schema, { $refStrategy: "none" });
}