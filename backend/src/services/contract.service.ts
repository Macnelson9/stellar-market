import { 
  Address, 
  Asset, 
  Contract, 
  Keypair, 
  Networks, 
  rpc, 
  scValToNative, 
  TransactionBuilder, 
  xdr,
  nativeToScVal,
  BASE_FEE
} from "@stellar/stellar-sdk";
import { config } from "../config";

const server = new rpc.Server(config.stellar.rpcUrl);
const networkPassphrase = config.stellar.networkPassphrase;
const contractId = config.stellar.escrowContractId;

export class ContractService {
  /**
   * Builds an un-signed transaction XDR for creating a job on-chain.
   */
  static async buildCreateJobTx(
    clientPublicKey: string,
    freelancerPublicKey: string,
    tokenContractId: string,
    milestones: { description: string; amount: number; deadline: number }[],
    jobDeadline: number
  ) {
    const contract = new Contract(contractId);
    const sourceAccount = await server.getLatestLedger(); // Dummy to get ledger, we need account seq
    // Note: To build a tx, we need the account's current sequence number.
    // The frontend can do this, but if the backend does it, it needs the public key.
    
    const account = await server.getAccount(clientPublicKey);
    
    const scMilestones = milestones.map(m => {
      return nativeToScVal([
        m.description,
        BigInt(Math.floor(m.amount * 10_000_000)), // Assuming 7 decimals for XLM/Token
        BigInt(m.deadline)
      ]);
    });

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
    .addOperation(
      contract.call(
        "create_job",
        new Address(clientPublicKey).toScVal(),
        new Address(freelancerPublicKey).toScVal(),
        new Address(tokenContractId).toScVal(),
        nativeToScVal(scMilestones, { type: "vec" }),
        nativeToScVal(BigInt(jobDeadline))
      )
    )
    .setTimeout(0)
    .build();

    return tx.toXDR();
  }

  /**
   * Builds an un-signed transaction XDR for funding a job.
   */
  static async buildFundJobTx(clientPublicKey: string, jobId: string) {
    const contract = new Contract(contractId);
    const account = await server.getAccount(clientPublicKey);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
    .addOperation(
      contract.call(
        "fund_job",
        nativeToScVal(BigInt(jobId)),
        new Address(clientPublicKey).toScVal()
      )
    )
    .setTimeout(0)
    .build();

    return tx.toXDR();
  }

  /**
   * Builds an un-signed transaction XDR for approving a milestone.
   */
  static async buildApproveMilestoneTx(clientPublicKey: string, jobId: string, milestoneId: number) {
    const contract = new Contract(contractId);
    const account = await server.getAccount(clientPublicKey);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
    .addOperation(
      contract.call(
        "approve_milestone",
        nativeToScVal(BigInt(jobId)),
        nativeToScVal(milestoneId, { type: "u32" }),
        new Address(clientPublicKey).toScVal()
      )
    )
    .setTimeout(0)
    .build();

    return tx.toXDR();
  }

  /**
   * Verification function to check transaction status on-chain.
   */
  static async verifyTransaction(hash: string) {
    const response = await server.getTransaction(hash);
    if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        // Extract results if needed
        return { success: true, result: response.resultXdr };
    }
    return { success: false, error: response.status };
  }

  /**
   * Builds an un-signed transaction XDR for raising a dispute.
   */
  static async buildRaiseDisputeTx(
    initiatorPublicKey: string,
    jobId: number,
    clientPublicKey: string,
    freelancerPublicKey: string,
    reason: string,
    minVotes: number
  ) {
    const contract = new Contract(config.stellar.disputeContractId);
    const account = await server.getAccount(initiatorPublicKey);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
    .addOperation(
      contract.call(
        "raise_dispute",
        nativeToScVal(BigInt(jobId)),
        new Address(clientPublicKey).toScVal(),
        new Address(freelancerPublicKey).toScVal(),
        new Address(initiatorPublicKey).toScVal(),
        nativeToScVal(reason),
        nativeToScVal(minVotes, { type: "u32" })
      )
    )
    .setTimeout(0)
    .build();

    return tx.toXDR();
  }

  /**
   * Builds an un-signed transaction XDR for casting a vote on a dispute.
   */
  static async buildCastVoteTx(
    voterPublicKey: string,
    disputeId: number,
    choice: number, // 0 for Client, 1 for Freelancer (based on enum in contract)
    reason: string
  ) {
    const contract = new Contract(config.stellar.disputeContractId);
    const account = await server.getAccount(voterPublicKey);

    // Soroban enums are typically represented as symbols or integers depending on the SDK mapping
    // Here we'll map 0 -> 'Client', 1 -> 'Freelancer' for the VoteChoice enum
    const choiceScVal = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol(choice === 0 ? "Client" : "Freelancer")
    ]);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
    .addOperation(
      contract.call(
        "cast_vote",
        nativeToScVal(BigInt(disputeId)),
        new Address(voterPublicKey).toScVal(),
        xdr.ScVal.scvSymbol(choice === 0 ? "Client" : "Freelancer"),
        nativeToScVal(reason)
      )
    )
    .setTimeout(0)
    .build();

    return tx.toXDR();
  }

  /**
   * Builds an un-signed transaction XDR for extending a milestone deadline.
   */
  static async buildExtendDeadlineTx(
    clientPublicKey: string,
    jobId: string,
    milestoneId: number,
    newDeadline: number,
  ) {
    const contract = new Contract(contractId);
    const account = await server.getAccount(clientPublicKey);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
    .addOperation(
      contract.call(
        "extend_deadline",
        nativeToScVal(BigInt(jobId)),
        nativeToScVal(milestoneId, { type: "u32" }),
        nativeToScVal(BigInt(newDeadline))
      )
    )
    .setTimeout(0)
    .build();

    return tx.toXDR();
  }

  /**
   * Builds an un-signed transaction XDR for resolving a dispute.
   */
  static async buildResolveDisputeTx(
    callerPublicKey: string,
    disputeId: number,
  ) {
    const contract = new Contract(config.stellar.disputeContractId);
    const account = await server.getAccount(callerPublicKey);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
    .addOperation(
      contract.call(
        "resolve_dispute",
        nativeToScVal(BigInt(disputeId)),
        new Address(config.stellar.escrowContractId).toScVal()
      )
    )
    .setTimeout(0)
    .build();

    return tx.toXDR();
  }
}
