import { computePoolAddress } from "@uniswap/v3-sdk";
import { UniV3LikePool } from "./uniV3LikePool.js";
import ContractAddresses from "./static/contractAddresses.json" assert { type: "json" };
import { getContract } from "viem";
import IUniswapV3PoolABI from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json" assert { type: "json" };

export class UniV3Pool extends UniV3LikePool {
  dex = "UniV3";

  constructor(token0, token1, fee, chain, viemClient) {
    super(token0, token1, fee, undefined, chain, viemClient);
  }

  getPoolContract = () => {
    const poolAddress = computePoolAddress({
      factoryAddress: ContractAddresses[this.chain.key].uniV3Factory,
      tokenA: this.token0,
      tokenB: this.token1,
      fee: this.fee,
    });

    this.contract = getContract({
      address: poolAddress,
      abi: IUniswapV3PoolABI.abi,
      client: this.viemClient,
    });
  };
}
