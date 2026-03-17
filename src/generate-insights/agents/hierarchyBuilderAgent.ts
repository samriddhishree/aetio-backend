import type { GraphState, Insight, PipelineError } from "../types";
import { config } from "../services/config";
import { openai, OPENAI_MODEL } from "../services/openai";
import { hashId } from "../services/utils";

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
          group_text: { type: "string" },
          member_ids: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["group_text", "member_ids"],
      },
    },
  },
  required: ["groups"],
} as const;

type HierarchyResponse = {
  groups: Array<{
    group_text: string;
    member_ids: string[];
  }>;
};

export async function hierarchyBuilderAgent(
  state: GraphState,
): Promise<Partial<GraphState>> {
  console.debug("HierarchyBuilderAgent:start", { insights: state.insights.length });
  const errors: PipelineError[] = [];
  const userId = state.userId;
  const projectId = state.projectId;
  const updatedInsights: Insight[] = state.insights.map((insight) => ({
    ...insight,
    user_id: userId ?? insight.user_id,
    status: "Pending",
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
        model: OPENAI_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are a hierarchy builder agent. Group related insights into high-level themes. Use only the provided insight IDs for membership. Return JSON that matches the schema.",
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

      for (const group of parsed.groups ?? []) {
        if (group.member_ids.length === 0) continue;
        const groupId = hashId(`${documentId}:${group.group_text}`);
        const groupInsight: Insight = {
          insight_id: groupId,
          text: group.group_text,
          s3_node: `doc:${documentId}`,
          document_id: documentId,
          user_id: userId,
          status: "Pending",
        };
        updatedInsights.push(groupInsight);

        for (const memberId of group.member_ids) {
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
          member.parent_insight_id = groupId;
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
