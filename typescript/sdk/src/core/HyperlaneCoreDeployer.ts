import debug from 'debug';
import { ethers } from 'ethers';

import {
  InterchainGasPaymaster,
  Mailbox,
  MultisigIsm,
  OverheadIgp,
  Ownable,
  Ownable__factory,
  ProxyAdmin,
  StorageGasOracle,
  ValidatorAnnounce,
} from '@hyperlane-xyz/core';
import { types, utils } from '@hyperlane-xyz/utils';

import multisigIsmVerifyCosts from '../consts/multisigIsmVerifyCosts.json';
import { DeployOptions, HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ProxiedContract, TransparentProxyAddresses } from '../proxy';
import { ChainMap, ChainName } from '../types';
import { objMap } from '../utils/objects';

import { CoreContracts, GasOracleContracts, coreFactories } from './contracts';
import { CoreConfig, GasOracleContractType } from './types';

export class HyperlaneCoreDeployer extends HyperlaneDeployer<
  CoreConfig,
  CoreContracts,
  typeof coreFactories
> {
  startingBlockNumbers: ChainMap<number | undefined>;
  gasOverhead: ChainMap<OverheadIgp.DomainConfigStruct>;

  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<CoreConfig>,
    factoriesOverride = coreFactories,
  ) {
    super(multiProvider, configMap, factoriesOverride, {
      logger: debug('hyperlane:CoreDeployer'),
    });
    this.gasOverhead = objMap(configMap, (chain, config) => {
      const { validators, threshold } = config.multisigIsm;
      const verifyCost =
        // @ts-ignore
        multisigIsmVerifyCosts[`${validators.length}`][`${threshold}`];
      if (!verifyCost)
        throw new Error(
          `Unknown verification cost for ${threshold} of ${validators.length}`,
        );
      return {
        domain: multiProvider.getDomainId(chain),
        gasOverhead: verifyCost,
      };
    });
    this.startingBlockNumbers = objMap(configMap, () => undefined);
  }

  async deployInterchainGasPaymaster(
    chain: ChainName,
    proxyAdmin: ProxyAdmin,
    gasOracleContracts: GasOracleContracts,
    deployOpts?: DeployOptions,
  ): Promise<
    ProxiedContract<InterchainGasPaymaster, TransparentProxyAddresses>
  > {
    const owner = this.configMap[chain].owner;
    const beneficiary = this.configMap[chain].igp.beneficiary;
    const igp = await this.deployProxiedContract(
      chain,
      'interchainGasPaymaster',
      [beneficiary],
      proxyAdmin,
      [owner, beneficiary],
      deployOpts,
    );

    // Set the gas oracles

    const configChains = Object.keys(this.configMap);
    const remotes = this.multiProvider
      .intersect(configChains, false)
      .multiProvider.getRemoteChains(chain);

    const gasOracleConfigsToSet: InterchainGasPaymaster.GasOracleConfigStruct[] =
      [];

    for (const remote of remotes) {
      const remoteId = this.multiProvider.getDomainId(remote);
      const currentGasOracle = await igp.contract.gasOracles(remoteId);
      const desiredGasOracle = this.getGasOracleAddress(
        chain,
        remote,
        gasOracleContracts,
      );
      if (!utils.eqAddress(currentGasOracle, desiredGasOracle)) {
        gasOracleConfigsToSet.push({
          remoteDomain: remoteId,
          gasOracle: desiredGasOracle,
        });
      }
    }

    if (gasOracleConfigsToSet.length > 0) {
      await this.runIfOwner(chain, igp.contract, async () =>
        this.multiProvider.handleTx(
          chain,
          igp.contract.setGasOracles(gasOracleConfigsToSet),
        ),
      );
    }

    return igp;
  }

  async deployDefaultIsmInterchainGasPaymaster(
    chain: ChainName,
    interchainGasPaymasterAddress: types.Address,
    deployOpts?: DeployOptions,
  ): Promise<OverheadIgp> {
    const deployer = await this.multiProvider.getSignerAddress(chain);
    // Transfer ownership to the deployer so the destination gas overheads can be set
    const initCalldata = Ownable__factory.createInterface().encodeFunctionData(
      'transferOwnership',
      [deployer],
    );
    const defaultIsmInterchainGasPaymaster = await this.deployContract(
      chain,
      'defaultIsmInterchainGasPaymaster',
      [interchainGasPaymasterAddress],
      {
        ...deployOpts,
        initCalldata,
      },
    );

    const configChains = Object.keys(this.configMap);
    const remotes = this.multiProvider
      .intersect(configChains, false)
      .multiProvider.getRemoteChains(chain);

    // Only set gas overhead configs if they differ from what's on chain
    const configs: OverheadIgp.DomainConfigStruct[] = [];
    for (const remote of remotes) {
      const gasOverhead = this.gasOverhead[remote];
      const existingOverhead =
        await defaultIsmInterchainGasPaymaster.destinationGasOverhead(
          gasOverhead.domain,
        );
      if (!existingOverhead.eq(gasOverhead.gasOverhead)) {
        configs.push(gasOverhead);
      }
    }

    if (configs.length > 0) {
      await this.runIfOwner(chain, defaultIsmInterchainGasPaymaster, () =>
        this.multiProvider.handleTx(
          chain,
          defaultIsmInterchainGasPaymaster.setDestinationGasOverheads(
            configs,
            this.multiProvider.getTransactionOverrides(chain),
          ),
        ),
      );
    }

    return defaultIsmInterchainGasPaymaster;
  }

  async deployGasOracleContracts(
    chain: ChainName,
    deployOpts?: DeployOptions,
  ): Promise<GasOracleContracts> {
    const storageGasOracle = await this.deployStorageGasOracle(
      chain,
      deployOpts,
    );
    return {
      storageGasOracle,
    };
  }

  async deployStorageGasOracle(
    chain: ChainName,
    deployOpts?: DeployOptions,
  ): Promise<StorageGasOracle> {
    return this.deployContract(chain, 'storageGasOracle', [], deployOpts);
  }

  async deployMailbox(
    chain: ChainName,
    defaultIsmAddress: types.Address,
    proxyAdmin: ProxyAdmin,
    deployOpts?: DeployOptions,
  ): Promise<ProxiedContract<Mailbox, TransparentProxyAddresses>> {
    const domain = this.multiProvider.getDomainId(chain);
    const owner = this.configMap[chain].owner;

    const mailbox = await this.deployProxiedContract(
      chain,
      'mailbox',
      [domain],
      proxyAdmin,
      [owner, defaultIsmAddress],
      deployOpts,
    );
    return mailbox;
  }

  async deployValidatorAnnounce(
    chain: ChainName,
    mailboxAddress: string,
    deployOpts?: DeployOptions,
  ): Promise<ValidatorAnnounce> {
    const validatorAnnounce = await this.deployContract(
      chain,
      'validatorAnnounce',
      [mailboxAddress],
      deployOpts,
    );
    return validatorAnnounce;
  }

  async deployMultisigIsm(chain: ChainName): Promise<MultisigIsm> {
    const multisigIsm = await this.deployContract(chain, 'multisigIsm', []);
    const configChains = Object.keys(this.configMap);
    const remotes = this.multiProvider
      .intersect(configChains, false)
      .multiProvider.getRemoteChains(chain);
    const overrides = this.multiProvider.getTransactionOverrides(chain);

    await super.runIfOwner(chain, multisigIsm, async () => {
      // TODO: Remove extraneous validators
      const remoteDomains = this.multiProvider.getDomainIds(remotes);
      const actualValidators = await Promise.all(
        remoteDomains.map((id) => multisigIsm.validators(id)),
      );
      const expectedValidators = remotes.map(
        (chain) => this.configMap[chain].multisigIsm.validators,
      );
      const validatorsToEnroll = expectedValidators.map((validators, i) =>
        validators.filter(
          (validator) =>
            !actualValidators[i].includes(ethers.utils.getAddress(validator)),
        ),
      );
      const chainsToEnrollValidators = remotes.filter(
        (_, i) => validatorsToEnroll[i].length > 0,
      );

      if (chainsToEnrollValidators.length > 0) {
        this.logger(
          `Enroll ${chainsToEnrollValidators} validators on ${chain}`,
        );

        await this.multiProvider.handleTx(
          chain,
          multisigIsm.enrollValidators(
            chainsToEnrollValidators.map((c) =>
              this.multiProvider.getDomainId(c),
            ),
            validatorsToEnroll.filter((validators) => validators.length > 0),
            overrides,
          ),
        );
      }

      const actualThresholds = await Promise.all(
        remoteDomains.map((id) => multisigIsm.threshold(id)),
      );
      const expectedThresholds = remotes.map(
        (chain) => this.configMap[chain].multisigIsm.threshold,
      );
      const chainsToSetThreshold = remotes.filter(
        (_, i) => actualThresholds[i] !== expectedThresholds[i],
      );
      if (chainsToSetThreshold.length > 0) {
        this.logger(
          `Set remote (${chainsToSetThreshold}) thresholds on ${chain}`,
        );
        await this.multiProvider.handleTx(
          chain,
          multisigIsm.setThresholds(
            chainsToSetThreshold.map((c) => this.multiProvider.getDomainId(c)),
            chainsToSetThreshold.map(
              (c) => this.configMap[c].multisigIsm.threshold,
            ),
            overrides,
          ),
        );
      }
    });

    return multisigIsm;
  }

  async deployContracts(
    chain: ChainName,
    config: CoreConfig,
  ): Promise<CoreContracts> {
    if (config.remove) {
      // skip deploying to chains configured to be removed
      return undefined as any;
    }

    const provider = this.multiProvider.getProvider(chain);
    const startingBlockNumber = await provider.getBlockNumber();
    this.startingBlockNumbers[chain] = startingBlockNumber;
    const multisigIsm = await this.deployMultisigIsm(chain);

    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);

    const gasOracleContracts = await this.deployGasOracleContracts(chain);
    const interchainGasPaymaster = await this.deployInterchainGasPaymaster(
      chain,
      proxyAdmin,
      gasOracleContracts,
    );
    const defaultIsmInterchainGasPaymaster =
      await this.deployDefaultIsmInterchainGasPaymaster(
        chain,
        interchainGasPaymaster.address,
      );
    const mailbox = await this.deployMailbox(
      chain,
      multisigIsm.address,
      proxyAdmin,
    );
    const validatorAnnounce = await this.deployValidatorAnnounce(
      chain,
      mailbox.address,
    );
    // Ownership of the Mailbox and the interchainGasPaymaster is transferred upon initialization.
    const ownables: Ownable[] = [
      multisigIsm,
      proxyAdmin,
      defaultIsmInterchainGasPaymaster,
    ];
    await this.transferOwnershipOfContracts(chain, ownables);

    return {
      ...gasOracleContracts,
      validatorAnnounce,
      proxyAdmin,
      mailbox,
      interchainGasPaymaster,
      defaultIsmInterchainGasPaymaster,
      multisigIsm,
    };
  }

  async transferOwnershipOfContracts(
    chain: ChainName,
    ownables: Ownable[],
  ): Promise<ethers.ContractReceipt[]> {
    const owner = this.configMap[chain].owner;
    const receipts: ethers.ContractReceipt[] = [];
    for (const ownable of ownables) {
      const currentOwner = await ownable.owner();
      if (currentOwner.toLowerCase() !== owner.toLowerCase()) {
        const receipt = await super.runIfOwner(chain, ownable, () =>
          this.multiProvider.handleTx(
            chain,
            ownable.transferOwnership(
              owner,
              this.multiProvider.getTransactionOverrides(chain),
            ),
          ),
        );
        if (receipt) receipts.push(receipt);
      }
    }

    return receipts.filter((x) => x !== undefined) as ethers.ContractReceipt[];
  }

  private getGasOracleAddress(
    local: ChainName,
    remote: ChainName,
    gasOracleContracts: GasOracleContracts,
  ): types.Address {
    const localConfig = this.configMap[local];
    const gasOracleType = localConfig.igp.gasOracles[remote];
    if (!gasOracleType) {
      throw Error(
        `Expected gas oracle type for local ${local} and remote ${remote}`,
      );
    }
    switch (gasOracleType) {
      case GasOracleContractType.StorageGasOracle: {
        return gasOracleContracts.storageGasOracle.address;
      }
      default: {
        throw Error(`Unsupported gas oracle type ${gasOracleType}`);
      }
    }
  }
}
