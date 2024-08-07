import { computePoolAddress } from "@uniswap/v3-sdk";
import { UniV3LikePool } from "./uniV3LikePool.js";
import { getContract } from "viem";
import IUniswapV3PoolABI from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json" assert { type: "json" };

export class UniV3Pool extends UniV3LikePool {
  dex = "UniV3";

  constructor(
    token0,
    token1,
    fee,
    tickSpacing,
    factoryAddress,
    chain,
    viemClient
  ) {
    super(token0, token1, fee, tickSpacing, factoryAddress, chain, viemClient);
  }

  getPoolContract = () => {
    const poolAddress = computePoolAddress({
      factoryAddress: this.factoryAddress,
      tokenA: this.token0,
      tokenB: this.token1,
      fee: this.getFee(),
    });

    this.contract = getContract({
      address: poolAddress,
      abi: IUniswapV3PoolABI.abi,
      client: this.viemClient,
    });
  };
}
