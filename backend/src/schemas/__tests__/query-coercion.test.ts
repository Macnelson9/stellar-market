import {
  getNotificationsQuerySchema,
  getJobsQuerySchema,
  getUsersQuerySchema,
  getReviewsQuerySchema,
  getApplicationsQuerySchema,
  getMilestonesQuerySchema,
  getMessagesQuerySchema,
  getRecommendationsQuerySchema,
} from "../index";
import { paginationSchema } from "../common";
import { createReviewSchema } from "../review";

/**
 * Query parameters always arrive as strings from HTTP.
 * These tests ensure all paginated query schemas accept string values
 * for numeric fields and coerce them to numbers.
 */
describe("Query parameter coercion (string → number)", () => {
  describe("paginationSchema", () => {
    it("should accept string page and limit and coerce to numbers", () => {
      const result = paginationSchema.parse({ page: "2", limit: "25" });
      expect(result.page).toBe(2);
      expect(result.limit).toBe(25);
    });

    it("should apply defaults when page and limit are omitted", () => {
      const result = paginationSchema.parse({});
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
    });

    it("should reject non-numeric strings", () => {
      expect(() => paginationSchema.parse({ page: "abc" })).toThrow();
    });

    it("should reject negative values", () => {
      expect(() => paginationSchema.parse({ page: "-1" })).toThrow();
    });

    it("should reject limit exceeding 100", () => {
      expect(() => paginationSchema.parse({ limit: "200" })).toThrow();
    });
  });

  describe("getNotificationsQuerySchema", () => {
    it("should accept string page and limit (simulating real HTTP query)", () => {
      const result = getNotificationsQuerySchema.parse({
        page: "1",
        limit: "5",
      });
      expect(result.page).toBe(1);
      expect(result.limit).toBe(5);
    });

    it("should apply defaults when omitted", () => {
      const result = getNotificationsQuerySchema.parse({});
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });
  });

  describe("getJobsQuerySchema", () => {
    it("should coerce page, limit, minBudget, maxBudget from strings", () => {
      const result = getJobsQuerySchema.parse({
        page: "1",
        limit: "10",
        minBudget: "100",
        maxBudget: "5000",
      });
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.minBudget).toBe(100);
      expect(result.maxBudget).toBe(5000);
    });
  });

  describe("getUsersQuerySchema", () => {
    it("should coerce page and limit from strings", () => {
      const result = getUsersQuerySchema.parse({
        page: "3",
        limit: "20",
        search: "stellar",
      });
      expect(result.page).toBe(3);
      expect(result.limit).toBe(20);
    });
  });

  describe("getReviewsQuerySchema", () => {
    it("should coerce page, limit, and rating from strings", () => {
      const result = getReviewsQuerySchema.parse({
        page: "1",
        limit: "10",
        rating: "5",
      });
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.rating).toBe(5);
    });

    it("should reject invalid rating from query string", () => {
      expect(() => getReviewsQuerySchema.parse({ rating: "6" })).toThrow();
      expect(() => getReviewsQuerySchema.parse({ rating: "0" })).toThrow();
    });
  });

  describe("getApplicationsQuerySchema", () => {
    it("should coerce page and limit from strings", () => {
      const result = getApplicationsQuerySchema.parse({
        page: "2",
        limit: "15",
      });
      expect(result.page).toBe(2);
      expect(result.limit).toBe(15);
    });
  });

  describe("getMilestonesQuerySchema", () => {
    it("should coerce page and limit from strings", () => {
      const result = getMilestonesQuerySchema.parse({
        page: "1",
        limit: "50",
      });
      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
    });
  });

  describe("getMessagesQuerySchema", () => {
    it("should coerce page and limit from strings", () => {
      const result = getMessagesQuerySchema.parse({
        page: "1",
        limit: "30",
      });
      expect(result.page).toBe(1);
      expect(result.limit).toBe(30);
    });
  });

  describe("getRecommendationsQuerySchema", () => {
    it("should coerce page and limit from strings", () => {
      const result = getRecommendationsQuerySchema.parse({
        page: "1",
        limit: "10",
      });
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
    });
  });
});

describe("Body schemas remain unaffected (no coercion needed)", () => {
  it("createReviewSchema should accept numeric rating from JSON body", () => {
    const result = createReviewSchema.parse({
      jobId: "550e8400-e29b-41d4-a716-446655440000",
      revieweeId: "550e8400-e29b-41d4-a716-446655440001",
      rating: 5,
      comment: "Excellent work on the project!",
    });
    expect(result.rating).toBe(5);
  });

  it("createReviewSchema should reject string rating in body", () => {
    expect(() =>
      createReviewSchema.parse({
        jobId: "550e8400-e29b-41d4-a716-446655440000",
        revieweeId: "550e8400-e29b-41d4-a716-446655440001",
        rating: "5",
        comment: "Excellent work on the project!",
      }),
    ).toThrow();
  });
});
