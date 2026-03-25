import { PrismaClient, DisputeStatus, JobStatus } from "@prisma/client";
import { DisputeService } from "../services/dispute.service";

const prisma = new PrismaClient();

describe("Dispute Management System", () => {
  let clientId: string;
  let freelancerId: string;
  let voterId: string;
  let jobId: string;

  beforeAll(async () => {
    // Create test users
    const client = await prisma.user.create({
      data: {
        walletAddress: "GCLIENT" + Math.random().toString(36).substring(2, 15),
        username: "testclient" + Date.now(),
        email: `client${Date.now()}@test.com`,
        role: "CLIENT",
      },
    });
    clientId = client.id;

    const freelancer = await prisma.user.create({
      data: {
        walletAddress: "GFREELANCER" + Math.random().toString(36).substring(2, 15),
        username: "testfreelancer" + Date.now(),
        email: `freelancer${Date.now()}@test.com`,
        role: "FREELANCER",
      },
    });
    freelancerId = freelancer.id;

    const voter = await prisma.user.create({
      data: {
        walletAddress: "GVOTER" + Math.random().toString(36).substring(2, 15),
        username: "testvoter" + Date.now(),
        email: `voter${Date.now()}@test.com`,
        role: "FREELANCER",
      },
    });
    voterId = voter.id;

    // Create test job
    const job = await prisma.job.create({
      data: {
        title: "Test Job for Dispute",
        description: "This is a test job",
        budget: 1000,
        category: "Development",
        clientId,
        freelancerId,
        status: JobStatus.IN_PROGRESS,
        deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        skills: ["JavaScript", "TypeScript"],
      },
    });
    jobId = job.id;
  });

  afterAll(async () => {

      await prisma.disputeVote.deleteMany({});
    await prisma.dispute.deleteMany({});
    await prisma.job.deleteMany({ where: { id: jobId } });
    await prisma.user.deleteMany({
      where: { id: { in: [clientId, freelancerId, voterId] } },
    });
    await prisma.$disconnect();
  });

  describe("createDispute", () => {
    it("should create a dispute successfully", async () => {
      const dispute = await DisputeService.createDispute(
        jobId,
        clientId,
        "The freelancer did not deliver the work as agreed"
      );

      expect(dispute).toBeDefined();
      expect(dispute.jobId).toBe(jobId);
      expect(dispute.clientId).toBe(clientId);
      expect(dispute.freelancerId).toBe(freelancerId);
      expect(dispute.initiatorId).toBe(clientId);
      expect(dispute.status).toBe(DisputeStatus.OPEN);
      expect(dispute.reason).toBe("The freelancer did not deliver the work as agreed");
    });

    it("should prevent duplicate disputes on the same job", async () => {
      await expect(
        DisputeService.createDispute(
          jobId,
          freelancerId,
          "Another dispute reason"
        )
      ).rejects.toThrow("A dispute already exists for this job");
    });

    it("should reject dispute from non-participant", async () => {
      const anotherJob = await prisma.job.create({
        data: {
          title: "Another Test Job",
          description: "Another test",
          budget: 500,
          category: "Design",
          clientId,
          freelancerId,
          status: JobStatus.IN_PROGRESS,
          deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          skills: ["Design"],
        },
      });

      await expect(
        DisputeService.createDispute(
          anotherJob.id,
          voterId,
          "I want to dispute this"
        )
      ).rejects.toThrow("Only job participants can raise a dispute");

      await prisma.job.delete({ where: { id: anotherJob.id } });
    });
  });

  describe("getDisputeById", () => {
    it("should retrieve dispute with full details", async () => {
      const disputes = await prisma.dispute.findMany({ where: { jobId } });
      const disputeId = disputes[0].id;

      const dispute = await DisputeService.getDisputeById(disputeId);

      expect(dispute).toBeDefined();
      expect(dispute.id).toBe(disputeId);
      expect(dispute.job).toBeDefined();
      expect(dispute.client).toBeDefined();
      expect(dispute.freelancer).toBeDefined();
      expect(dispute.votes).toBeDefined();
    });

    it("should throw error for non-existent dispute", async () => {
      await expect(
        DisputeService.getDisputeById("non-existent-id")
      ).rejects.toThrow("Dispute not found");
    });
  });

  describe("getDisputes", () => {
    it("should return paginated disputes", async () => {
      const result = await DisputeService.getDisputes(
        {},
        { page: 1, limit: 10 }
      );

      expect(result.disputes).toBeDefined();
      expect(Array.isArray(result.disputes)).toBe(true);
      expect(result.pagination).toBeDefined();
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(10);
    });

    it("should filter disputes by status", async () => {
      const result = await DisputeService.getDisputes(
        { status: DisputeStatus.OPEN },
        { page: 1, limit: 10 }
      );

      expect(result.disputes.every(d => d.status === DisputeStatus.OPEN)).toBe(true);
    });
  });

  describe("castVote", () => {
    let disputeId: string;

    beforeAll(async () => {
      const disputes = await prisma.dispute.findMany({ where: { jobId } });
      disputeId = disputes[0].id;
    });

    it("should cast a vote successfully", async () => {
      const vote = await DisputeService.castVote(
        disputeId,
        voterId,
        "CLIENT",
        "The client has valid concerns about the deliverables"
      );

      expect(vote).toBeDefined();
      expect(vote.disputeId).toBe(disputeId);
      expect(vote.voterId).toBe(voterId);
      expect(vote.choice).toBe("CLIENT");
    });

    it("should update dispute status to IN_PROGRESS after first vote", async () => {
      const dispute = await prisma.dispute.findUnique({
        where: { id: disputeId },
      });

      expect(dispute?.status).toBe(DisputeStatus.IN_PROGRESS);
    });

    it("should prevent duplicate votes", async () => {
      await expect(
        DisputeService.castVote(
          disputeId,
          voterId,
          "FREELANCER",
          "Changed my mind"
        )
      ).rejects.toThrow("You have already voted on this dispute");
    });

    it("should prevent participants from voting", async () => {
      await expect(
        DisputeService.castVote(
          disputeId,
          clientId,
          "CLIENT",
          "I vote for myself"
        )
      ).rejects.toThrow("Dispute participants cannot vote");

      await expect(
        DisputeService.castVote(
          disputeId,
          freelancerId,
          "FREELANCER",
          "I vote for myself"
        )
      ).rejects.toThrow("Dispute participants cannot vote");
    });
  });

  describe("getVoteStats", () => {
    let disputeId: string;

    beforeAll(async () => {
      const disputes = await prisma.dispute.findMany({ where: { jobId } });
      disputeId = disputes[0].id;
    });

    it("should return accurate vote statistics", async () => {
      const stats = await DisputeService.getVoteStats(disputeId);

      expect(stats).toBeDefined();
      expect(stats.total).toBeGreaterThan(0);
      expect(stats.votesForClient).toBeDefined();
      expect(stats.votesForFreelancer).toBeDefined();
      expect(stats.total).toBe(stats.votesForClient + stats.votesForFreelancer);
    });
  });

  describe("resolveDispute", () => {
    let disputeId: string;

    beforeAll(async () => {
      const disputes = await prisma.dispute.findMany({ where: { jobId } });
      disputeId = disputes[0].id;
    });

    it("should resolve dispute successfully", async () => {
      const dispute = await DisputeService.resolveDispute(
        disputeId,
        "Resolved in favor of client based on community vote"
      );

      expect(dispute).toBeDefined();
      expect(dispute.status).toBe(DisputeStatus.RESOLVED);
      expect(dispute.outcome).toBe("Resolved in favor of client based on community vote");
      expect(dispute.resolvedAt).toBeDefined();
    });

    it("should prevent resolving already resolved dispute", async () => {
      await expect(
        DisputeService.resolveDispute(
          disputeId,
          "Trying to resolve again"
        )
      ).rejects.toThrow("Dispute is already resolved");
    });

    it("should prevent voting on resolved dispute", async () => {
      const anotherVoter = await prisma.user.create({
        data: {
          walletAddress: "GVOTER2" + Math.random().toString(36).substring(2, 15),
          username: "testvoter2" + Date.now(),
          email: `voter2${Date.now()}@test.com`,
          role: "FREELANCER",
        },
      });

      await expect(
        DisputeService.castVote(
          disputeId,
          anotherVoter.id,
          "FREELANCER",
          "Late vote"
        )
      ).rejects.toThrow("Cannot vote on a resolved dispute");

      await prisma.user.delete({ where: { id: anotherVoter.id } });
    });
  });

  describe("processWebhook", () => {
    it("should process DISPUTE_RAISED webhook", async () => {
      const newJob = await prisma.job.create({
        data: {
          title: "Webhook Test Job",
          description: "Test",
          budget: 800,
          category: "Testing",
          clientId,
          freelancerId,
          status: JobStatus.IN_PROGRESS,
          deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          skills: ["Testing"],
        },
      });

      const newDispute = await DisputeService.createDispute(
        newJob.id,
        clientId,
        "Webhook test dispute"
      );

      const result = await DisputeService.processWebhook({
        type: "DISPUTE_RAISED",
        disputeId: newDispute.id,
        onChainDisputeId: "12345",
      });

      expect(result.success).toBe(true);

      const updated = await prisma.dispute.findUnique({
        where: { id: newDispute.id },
      });
      expect(updated?.onChainDisputeId).toBe("12345");

      await prisma.dispute.delete({ where: { id: newDispute.id } });
      await prisma.job.delete({ where: { id: newJob.id } });
    });

    it("should handle unknown webhook type", async () => {
      await expect(
        DisputeService.processWebhook({
          type: "UNKNOWN_TYPE" as any,
          disputeId: "test",
        })
      ).rejects.toThrow("Unknown webhook type");
    });
  });
});
