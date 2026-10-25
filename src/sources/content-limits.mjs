// Resource ceilings reject oversized bodies; they never define a stored excerpt.
export const MAX_ARTICLE_BYTES = 1024 * 1024;
export const MAX_BATCH_BYTES = 10 * MAX_ARTICLE_BYTES;
export const MAX_SUMMARY_CHARACTERS = 5000;
