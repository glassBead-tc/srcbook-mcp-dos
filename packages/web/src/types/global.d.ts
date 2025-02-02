interface SrcbookConfig {
  api: {
    host: string;
    origin: string;
  };
}

declare global {
  interface Window {
    SRCBOOK_CONFIG: SrcbookConfig;
  }
}

export {};
