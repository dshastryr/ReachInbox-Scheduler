export function validateScheduleDraft(draft) {
  if (!draft.senderId || !draft.senderIds?.includes(draft.senderId)) return "Choose one of your sender accounts.";
  if (!draft.recipients?.length) return "Add at least one valid recipient.";
  if (!draft.subject?.trim() || !draft.body?.trim()) return "Subject and email body are required.";
  if (!Number.isInteger(Number(draft.delayMs)) || Number(draft.delayMs) < 0) return "Delay must be a non-negative whole number of milliseconds.";
  if (!Number.isInteger(Number(draft.hourlyLimit)) || Number(draft.hourlyLimit) < 1) return "Hourly limit must be a positive whole number.";
  if (!Number.isFinite(new Date(draft.startAt).getTime())) return "Choose a valid send date and time.";
  return "";
}
