import "dotenv/config";
import chains, { getToken } from "./chain-helper.js";
import { setupIndexing } from "./uniV3-helper.js";
import { createClient } from "redis";

const redisClient = createClient({ url: "redis://127.0.0.1:6380" });
redisClient.on("error", (err) => console.log("Redis Client Error", err));
await redisClient.connect();

const pools = [];

for (const [chainName, chain] of Object.entries(chains)) {
  const activePools = await redisClient
    .hVals(`pools:${chainName}`, "active-pools")
    .then((v) => JSON.parse(v));

  for (const pool of activePools) {
    pools.push({
      poolType: "UniV3",
      chain: chain,
      factoryAddress: chain.uniV3FactoryAddress,
      tokenA: getToken(chain.chainId, pool[0]),
      tokenB: getToken(chain.chainId, pool[1]),
      fee: pool[2],
    });
  }
}

pools.map((v) =>
  setupIndexing(redisClient, v.chain, v.tokenA, v.tokenB, v.fee)
);
