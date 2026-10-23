/**
 * Optional history labels for pushes: after an approval reaches Overleaf,
 * name that version in the project's history ("<commit message> (BlattBot)"),
 * so co-authors can see in Overleaf's History view what BlattBot pushed and
 * restore the version before it. Opt-in per project (Project settings). The
 * push has already landed when this runs, so a failure is only a warning.
 */
import type { OverleafClient } from "./olclient.js";

/** Overleaf shows labels in a narrow column; keep them short. */
export const MAX_LABEL_LENGTH = 120;

/** The label for a push: the commit message's first line, marked as BlattBot's. */
export function pushLabelText(message: string): string {
  const subject = message.split("\n")[0].trim() || "BlattBot edit";
  const suffix = " (BlattBot)";
  const room = MAX_LABEL_LENGTH - suffix.length;
  return (subject.length > room ? `${subject.slice(0, room - 1)}…` : subject) + suffix;
}

/** Label the project's newest history version, which includes the push that just landed. */
export async function labelPush(
  client: OverleafClient,
  projectId: string,
  message: string,
): Promise<{ comment: string; version: number }> {
  const version = await client.latestHistoryVersion(projectId);
  if (version === null) throw new Error("Overleaf's history does not show the push yet");
  const comment = pushLabelText(message);
  await client.addHistoryLabel(projectId, comment, version);
  return { comment, version };
}
