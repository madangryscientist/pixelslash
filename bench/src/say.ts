/** Output without `console` (the lint config bans it outside scripts/). */
export const say = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

export const warn = (text: string): void => {
  process.stderr.write(`${text}\n`);
};
