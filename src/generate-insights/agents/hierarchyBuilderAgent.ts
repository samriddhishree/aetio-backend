import type { GraphState, Insight, PipelineError } from "../../types";
import { config } from "../../common/services/config";
import { openai, OPENAI_HELPER_MODEL } from "../../common/services/openai";
import { hashId } from "../../common/services/utils";
/*
const HIERARCHY_PROMPT = `
You are a hierarchy builder agent.

Your task is to organize insights into parent-child relationships WITHOUT introducing abstraction or generic themes.

Core rules:

1. Do NOT create high-level or generic summaries.
   - Avoid vague themes like "Market Trends", "Economic Factors", etc.

2. Parent insights must remain concrete and close to the original insight text.
   - A parent insight should be a slightly more general version of its children, but still specific.

3. Sub-insights should:
   - Be closely derived from an existing insight
   - Modify or refine the original insight using metadata (e.g., region, segment, product)
   - Not introduce new information

4. Preserve specificity:
   - Every insight must remain grounded in the original evidence
   - Do NOT generalize beyond what is supported

5. Use metadata to shape hierarchy:
   - Group insights when they differ primarily by metadata (e.g., same concept across regions or segments)
   - Parent insight = shared concept
   - Child insights = metadata-specific variants

6. Do NOT rewrite insights into summaries.
   - Prefer minimal edits (e.g., slight generalization or removing qualifiers)

7. Use ONLY the provided insight_ids.
   - Do not create new insights.

8. If no clear hierarchy exists, keep insights as flat (no parent-child) relationships.

Output format:
- Return a hierarchy using parent_insight_id relationships
- Each insight must have:
  - insight_id
  - parent_insight_id (or null if root)

Goal:
Create a structure where:
- Parents represent shared concepts
- Children represent metadata-specific refinements of that concept

Return ONLY valid JSON matching the schema.
`;
*/
const HIERARCHY_PROMPT = `
You are a hierarchy builder agent.

Your task is to group existing insights into parent-child relationships using ONLY the provided insight IDs.

Rules:

1. Do NOT create new insights.
2. Do NOT rewrite, summarize, or generalize insight text.
3. Do NOT invent high-level themes.
4. A parent must always be an existing insight.
5. group_id must be an existing insight_id, and represents the parent insight for that group.
6. Children must also be existing insight_ids.
7. Only group insights when one existing insight is a clear parent concept of other existing insights.
8. If no clear parent-child relationship exists, leave the insight ungrouped.
9. Use metadata only to determine grouping relationships, not to generate new text.

Return JSON in this format:

{
  "groups": [
    {
      "group_id": "existing_parent_insight_id",
      "insight_ids": [
        "child_insight_id_1",
        "child_insight_id_2"
      ]
    }
  ],
  "ungrouped_insight_ids": [
    "insight_id_3"
  ]
}

Additional constraints:
- group_id must not appear inside its own insight_ids array.
- Every insight_id in the output must come from the provided input.
- Do not assign an insight to more than one group.
- Prefer no grouping over weak or generic grouping.

Return ONLY valid JSON matching the schema.
`;
const HIERARCHY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          group_id: { type: "string" },
          insight_ids: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["group_id", "insight_ids"],
      },
    },
    ungrouped_insight_ids: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["groups", "ungrouped_insight_ids"],
} as const;

type HierarchyResponse = {
  groups: Array<{
    group_id: string;
    insight_ids: string[];
  }>;
  ungrouped_insight_ids: string[];
};

export async function hierarchyBuilderAgent(
  state: GraphState,
): Promise<Partial<GraphState>> {
  console.debug("HierarchyBuilderAgent:start", { insights: state.insights.length });
  const errors: PipelineError[] = [];
  const userId = state.userId;
  const userInfo = state.userInfo;
  const projectId = state.projectId;
  const updatedInsights: Insight[] = state.insights.map((insight) => ({
    ...insight,
    user_id: userId ?? insight.user_id,
    user_info: userInfo ?? insight.user_info,
    status: "Pending",
    project_id: projectId
  }));
  const insightById = new Map(
    updatedInsights.map((insight) => [insight.insight_id, insight]),
  );

  const insightsByDocument = new Map<string, Insight[]>();
  for (const insight of updatedInsights) {
    const list = insightsByDocument.get(insight.document_id) ?? [];
    list.push(insight);
    insightsByDocument.set(insight.document_id, list);
  }

  for (const [documentId, insights] of insightsByDocument) {
    const topLevel = insights.filter((insight) => !insight.parent_insight_id);
    if (topLevel.length < 2) continue;

    try {
      const response = await openai.chat.completions.create({
        model: OPENAI_HELPER_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: HIERARCHY_PROMPT,
          },
          {
            role: "user",
            content: `Insights:\n${topLevel
              .map((insight) => `- ${insight.insight_id}: ${insight.text}`)
              .join("\n")}`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "hierarchy_builder",
            schema: HIERARCHY_SCHEMA,
            strict: true,
          },
        },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("Empty OpenAI response.");

      const parsed = JSON.parse(content) as HierarchyResponse;
      console.debug("HierarchyBuilderAgent:parsed-response", JSON.stringify(parsed));
      for (const group of parsed.groups ?? []) {
        const groupInsight = insightById.has(group.group_id)
        if (group.insight_ids.length === 0 || groupInsight) continue;
        
        for (const memberId of group.insight_ids) {
          const member = insightById.get(memberId);
          if (!member) {
            errors.push({
              stage: "HierarchyBuilderAgent",
              message: `Unknown insight id ${memberId} in grouping`,
              document_id: documentId,
            });
            continue;
          }
          if (member.parent_insight_id) continue;
          member.parent_insight_id = groupInsight.insight_id;
        }
      }
    } catch (error) {
      errors.push({
        stage: "HierarchyBuilderAgent",
        message: error instanceof Error ? error.message : "Unknown error",
        document_id: documentId,
        cause: error,
      });
    }
  }

  // Add project id to top level insights
  if (projectId) {
    for (const insight of updatedInsights) {
      if (!insight.parent_insight_id) {
        insight.parent_insight_id = projectId;
      }
    }
  }
  let response = {
    insights: updatedInsights,
    errors: state.errors.concat(errors),
  };
  console.debug("HierarchyBuilderAgent:end",  response);
  console.debug("HierarchyBuilderAgent:end:projectId",  projectId);

  return response;
}
