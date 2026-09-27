import cors from "cors";
import express from "express";
import { prisma } from "./lib/prisma";
import authRouter from "./routes/auth";
import googleAuthRouter from "./routes/google-auth";
import campaignsRouter from "./routes/campaigns";
import sendersRouter from "./routes/senders";
import searchRouter from "./routes/search";
import slackRouter from "./routes/slack";
import usersRouter from "./routes/users";
import emailsRouter from "./routes/emails";
import queueDashboardRouter from "./routes/queue-dashboard";

const app = express();

const frontendOrigin = process.env.FRONTEND_URL?.trim() || "http://localhost:5173";
app.use(cors({ origin: frontendOrigin, credentials: true }));
app.use(express.json());

app.use("/api/auth/google", googleAuthRouter);
app.use("/api/auth", authRouter);
app.use("/api/campaigns", campaignsRouter);
app.use("/api/senders", sendersRouter);
app.use("/api/search", searchRouter);
app.use("/api/emails", emailsRouter);
app.use("/api/slack", slackRouter);
app.use("/api/users", usersRouter);
app.use("/admin/queues", queueDashboardRouter);

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: "ok", database: "connected" });
  } catch {
    res.status(503).json({ status: "error", database: "disconnected" });
  }
});

export default app;
