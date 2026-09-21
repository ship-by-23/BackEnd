export {};

declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- Express extends requests through interface merging.
    interface Request {
      auth?: {
        userId: string;
        role: "user" | "admin";
      };
    }
  }
}
