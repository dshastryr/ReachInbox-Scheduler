import { Router } from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { emailQueue } from "../lib/queue";
import { getRequestUserId } from "../lib/auth-session";

const dashboardPath = "/admin/queues";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath(dashboardPath);

createBullBoard({
  queues: [new BullMQAdapter(emailQueue, { readOnlyMode: true })],
  serverAdapter,
});

const router = Router();
router.use(async (req, res, next) => {
  try {
    const userId = await getRequestUserId(req);
    if (!userId || !UUID_PATTERN.test(userId)) {
      res.status(401).send("Authentication is required to view the queue dashboard.");
      return;
    }
    next();
  } catch {
    res.status(503).send("Unable to verify authentication.");
  }
});
router.use(serverAdapter.getRouter());

export default router;
