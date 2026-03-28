import { z } from "zod";
import { paginationSchema } from "./common";

export const getNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const getNotificationByIdParamSchema = z.object({
  id: z.string().cuid(),
});
