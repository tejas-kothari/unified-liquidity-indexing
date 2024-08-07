import { UniV3LikePool } from "./uniV3LikePool.js";
import ICLPool from "./static/ICLPool.json" assert { type: "json" };
import { getContract, parseAbi } from "viem";

export class VeloV3Pool extends UniV3LikePool {
  dex = "VeloV3";

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

  getPoolContract = async () => {
    const factoryContract = getContract({
      address: this.factoryAddress,
      abi: parseAbi([
        "function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address pool)",
      ]),
      client: this.viemClient,
    });

    const poolAddress = await factoryContract.read.getPool([
      this.token0.address,
      this.token1.address,
      this.tickSpacing,
    ]);

    this.contract = getContract({
      address: poolAddress,
      abi: ICLPool.abi,
      client: this.viemClient,
    });
  };
}
