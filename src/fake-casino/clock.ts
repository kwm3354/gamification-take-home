/** The fake is the outside world, so it may read the real clock. All reads go through here. */
export const now = (): number => Date.now();
