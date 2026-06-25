export interface Config {
  telegram: {
    token: string;
    allowedUserId: number;
  };
  vibe: {
    projectDir: string;
  };
  server: {
    logLevel: string;
  };
}
