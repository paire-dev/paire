export const PAIRWISE_PROMPT = `You are comparing two structured reviews (A and B) of the SAME git diff.
Decide which better transfers understanding of the change to a busy human reviewer.
Faithfulness and completeness dominate style. Output exactly one fenced JSON block:
{"winner":"A|B|tie","confidence":"strong|weak","decidingFactors":["..."]}.`;
