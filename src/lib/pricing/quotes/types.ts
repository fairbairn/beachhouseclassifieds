export type QuoteProgress = {
  phase(message: string): void;
  tick(message: string): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  failure(message: string): void;
};

export type QuoteAdapter = {
  adapterKey: string;
  run(argv: string[], progress: QuoteProgress): Promise<void>;
};
