import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./config.js";
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});
redis.on("error", () => {});
export const queueOptions = { connection: redis };
export const emailQueue = new Queue("email-delivery", queueOptions);
export const indexQueue = new Queue("email-search", queueOptions);
export const slackQueue = new Queue("slack-notifications", queueOptions);
export const retention = {
  removeOnComplete: { age: 604800, count: 20000 },
  removeOnFail: { age: 1209600, count: 20000 },
};
