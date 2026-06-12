export const PROBE_GENERATE_PROMPT = `Generate exactly 8 factual comprehension questions about a git diff.
Each question must be answerable from the diff alone, include exactly 2 no/unchanged questions,
and avoid line-number, variable-name, and formatting trivia. Output one fenced JSON block.`;

export const PROBE_ANSWER_PROMPT = `You have read ONLY the structured review, not the diff.
Answer each question from the review alone. If the review does not contain enough information,
answer exactly "cannot tell from the review". Output one fenced JSON block.`;

export const PROBE_GRADE_PROMPT = `Grade each answer against the ground truth as CORRECT, ABSTAIN, or INCORRECT.
CORRECT means semantically equivalent; ABSTAIN means the answer is exactly "cannot tell from the review".`;
