import type { NextApiRequest, NextApiResponse } from "next";

import { handleRequest } from "../../server.mjs";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await handleRequest(req, res);
}
