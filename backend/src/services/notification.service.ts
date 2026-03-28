import { PrismaClient, NotificationType } from "@prisma/client";
import { getIo } from "../socket";

const prisma = new PrismaClient();

export class NotificationService {
  /**
   * Creates a notification in the database and sends it in real-time via Socket.IO.
   */
  static async sendNotification(params: {
    userId: string;
    type: NotificationType;
    title: string;
    message: string;
    metadata?: any;
  }) {
    const { userId, type, title, message, metadata } = params;

    try {
      // 1. Create DB record
      const notification = await prisma.notification.create({
        data: {
          userId,
          type,
          title,
          message,
          metadata: metadata || {},
        },
      });

      // 2. Emit real-time event via Socket.IO
      const io = getIo();
      io.to(`user:${userId}`).emit("notification:new", notification);

      console.log(`Notification sent to user ${userId}: ${type} - ${title}`);
      return notification;
    } catch (error) {
      console.error("Error sending notification:", error);
      // We don't throw here to avoid failing the main action if notification fails
      return null;
    }
  }

  /**
   * Marks a single notification as read.
   */
  static async markAsRead(notificationId: string, userId: string) {
    return prisma.notification.updateMany({
      where: {
        id: notificationId,
        userId,
      },
      data: {
        read: true,
      },
    });
  }

  /**
   * Marks all notifications as read for a specific user.
   */
  static async markAllAsRead(userId: string) {
    return prisma.notification.updateMany({
      where: {
        userId,
        read: false,
      },
      data: {
        read: true,
      },
    });
  }

  /**
   * Gets unread notification count for a specific user.
   */
  static async getUnreadCount(userId: string) {
    return prisma.notification.count({
      where: {
        userId,
        read: false,
      },
    });
  }

  /**
   * Gets paginated notifications for a specific user.
   */
  static async getNotifications(
    userId: string,
    page: number = 1,
    limit: number = 20,
  ) {
    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.notification.count({ where: { userId } }),
    ]);

    return {
      data: notifications,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get a notification by id
   */
  static async getById(id: string) {
    return prisma.notification.findUnique({ where: { id } });
  }

  /**
   * Delete a notification by id
   */
  static async deleteById(id: string) {
    return prisma.notification.delete({ where: { id } });
  }

  /**
   * Delete all read notifications for a user
   */
  static async deleteAllRead(userId: string) {
    return prisma.notification.deleteMany({ where: { userId, read: true } });
  }
}
