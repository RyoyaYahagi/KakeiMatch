import { afterEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { LocalDataRepository } from "./local-data";
import { createAccountMetadataAccess } from "../../apps/pwa/src/local-account-metadata";

const repositories: LocalDataRepository[] = [];

async function openRepository(profileId: string, factory = new IDBFactory()): Promise<LocalDataRepository> {
  const repository = await LocalDataRepository.open(profileId, factory);
  repositories.push(repository);
  return repository;
}

afterEach(() => repositories.splice(0).forEach((repository) => repository.close()));

describe("account metadata access", () => {
  it("keeps provider mappings isolated by profile, budget, and account", async () => {
    const factory = new IDBFactory();
    const first = createAccountMetadataAccess(await openRepository("profile-a", factory));
    const second = createAccountMetadataAccess(await openRepository("profile-b", factory));
    await first.saveAccountType("budget-a", "account-a", "credit_card");
    await first.saveStatementProvider("budget-a", "account-a", "paypay", "credit_card");

    expect(await first.getStatementProvider("budget-a", "account-a")).toBe("paypay");
    expect(await first.getStatementProvider("budget-b", "account-a")).toBeNull();
    expect(await first.getStatementProvider("budget-a", "account-b")).toBeNull();
    expect(await second.getStatementProvider("budget-a", "account-a")).toBeNull();
  });

  it("deletes all metadata when Actual clears an account type", async () => {
    const repository = await openRepository("profile-null-type");
    const access = createAccountMetadataAccess(repository);
    await access.saveAccountType("budget", "account", "credit_card");
    await access.saveStatementProvider("budget", "account", "smbc_card", "credit_card");

    await access.saveAccountType("budget", "account", null);

    expect(await repository.get("account-metadata:budget:account")).toBeNull();
    expect(await access.getAccountType("budget", "account")).toBeNull();
    expect(await access.getStatementProvider("budget", "account")).toBeNull();
  });

  it("preserves a provider when a non-null account type is updated", async () => {
    const access = createAccountMetadataAccess(await openRepository("profile-preserve"));
    await access.saveAccountType("budget", "account", "credit_card");
    await access.saveStatementProvider("budget", "account", "rakuten_card", "credit_card");

    await access.saveAccountType("budget", "account", "other");

    expect(await access.getAccountType("budget", "account")).toBe("other");
    expect(await access.getStatementProvider("budget", "account")).toBe("rakuten_card");
  });

  it("rejects statement providers for a cash account using the stored effective type", async () => {
    const access = createAccountMetadataAccess(await openRepository("profile-cash"));
    await access.saveAccountType("budget", "account", "cash");

    await expect(access.saveStatementProvider("budget", "account", "paypay", "credit_card"))
      .rejects.toThrow("現金口座には明細サービスを設定できません。");
    expect(await access.getStatementProvider("budget", "account")).toBeNull();
  });

  it("serializes concurrent account-type and provider updates without losing either value", async () => {
    const access = createAccountMetadataAccess(await openRepository("profile-concurrent"));
    await access.saveAccountType("budget", "account", "credit_card");

    await Promise.all([
      access.saveAccountType("budget", "account", "other"),
      access.saveStatementProvider("budget", "account", "paypay", "credit_card"),
    ]);

    expect(await access.getAccountType("budget", "account")).toBe("other");
    expect(await access.getStatementProvider("budget", "account")).toBe("paypay");
  });
});
