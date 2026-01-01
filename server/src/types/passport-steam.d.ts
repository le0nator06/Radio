declare module 'passport-steam' {
  import { Strategy as PassportStrategy, Profile } from 'passport';

  export interface StrategyOptions {
    returnURL: string;
    realm: string;
    apiKey: string;
  }

  export type VerifyFunction = (
    identifier: string,
    profile: Profile,
    done: (error: any, user?: any) => void
  ) => void;

  export class Strategy extends PassportStrategy {
    constructor(options: StrategyOptions, verify: VerifyFunction);
  }
}
