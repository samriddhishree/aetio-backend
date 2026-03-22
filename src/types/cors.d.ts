declare module "cors" {
  import type { RequestHandler } from "express";

  type CorsCallback = (err: Error | null, allow?: boolean) => void;

  type CorsOptions = {
    origin?:
      | boolean
      | string
      | RegExp
      | Array<string | RegExp>
      | ((origin: string | undefined, callback: CorsCallback) => void);
    methods?: string | string[];
    allowedHeaders?: string | string[];
    credentials?: boolean;
  };

  function cors(options?: CorsOptions): RequestHandler;
  export default cors;
}
