import Web3 from 'web3';
import { ethers } from 'ethers';
import request from  'request-promise-native';

import {
  outputFileSync,
  readFileSync
} from 'fs-extra';

import { cborDecode } from './utils';
import { BlockTransactionObject } from 'web3-eth';

const multihashes = require('multihashes');

const read = readFileSync;
const save = outputFileSync;
const log = console.log;

export interface MonitorConfig {
  ipfsCatRequest? : string,
  ipfsProvider? : any,
  swarmGateway? : string,
  repository? : string,
  infuraPID? : string,
  blockTime? : number
}

export interface CustomChainConfig {
  name: string,
  url: string
}

declare interface ChainSet {
  [key: string]: ChainData
}

declare interface ChainData {
  web3 : Web3,
  metadataQueue: Queue,
  sourceQueue: Queue,
  latestBlock : number
}

declare interface Queue {
  [key: string]: QueueItem;
}

declare interface QueueItem {
  bzzr1? : string,
  ipfs? : string,
  timestamp? : number,
  metadataRaw? : string,
  sources?: any
}

declare interface StringToBooleanMap {
  [key: string]: boolean;
}

export default class Monitor {
  private chains : ChainSet;
  private ipfsCatRequest: string;
  private ipfsProvider: any;
  private swarmGateway: string;
  private repository: string;
  private infuraPID: string;;
  private blockTime: number;
  private blockInterval: any;
  private sourceInterval: any;
  private metadataInterval: any;

  /**
   * Constructor
   *
   * @param {MonitorConfig = {}} config [description]
   */
  constructor(config: MonitorConfig = {}) {
    this.chains = {};

    this.ipfsCatRequest = config.ipfsCatRequest || 'https://ipfs.infura.io:5001/api/v0/cat?arg=';
    this.ipfsProvider = config.ipfsProvider || null;
    this.swarmGateway = 'https://swarm-gateways.net/';
    this.repository = config.repository || 'repository';
    this.infuraPID = config.infuraPID || '891fe57328084fcca24912b662ad101f';
    this.blockTime = config.blockTime || 15 // seconds;

    this.blockInterval = null;
    this.sourceInterval = null;
    this.metadataInterval = null;
  }

  /**
   * Starts running the monitor, listening to public eth chains via Infura for new contract
   * deployments and inserting them in a queue that periodically queries decentralized storage
   * providers like IPFS to retrieve metadata stored at the hash embedded in a contract's deployed
   * bytecode. Can be configured to listen to a single custom network (like localhost) for testing.
   *
   * @param  {CustomChainConfig} customChain
   * @return {Promise<void>}
   */
  public async start(customChain? : CustomChainConfig) : Promise<void> {
    const chainNames: string[] = customChain
      ? [customChain.name]
      : ['mainnet', 'ropsten', 'rinkeby', 'kovan', 'goerli'];

    for (const chain of chainNames){

      const url : string = customChain
        ? customChain.url
        : `https://${chain}.infura.io/v3/${this.infuraPID}`;

      this.chains[chain] = {
        web3: new Web3(url),
        metadataQueue: {},
        sourceQueue: {},
        latestBlock: 0
      };

      const blockNumber = await this.chains[chain].web3.eth.getBlockNumber();
      this.chains[chain].latestBlock = blockNumber;
      log(`${chain}: Starting from block ${blockNumber}`);
    }

    this.blockInterval = setInterval(this.retrieveBlocks.bind(this), 1000 * this.blockTime);
    this.metadataInterval = setInterval(this.retrieveMetadata.bind(this), 1000 * this.blockTime);
    this.sourceInterval = setInterval(this.retrieveSource.bind(this), 1000 * this.blockTime);
  }

  /**
   * Shuts down the monitor
   */
  public stop() : void {
    log('Stopping monitor...')
    clearInterval(this.blockInterval);
    clearInterval(this.metadataInterval);
    clearInterval(this.sourceInterval);
  }

  /**
   * Wraps the ipfs.cat command. `cat` can be run with in-memory ipfs
   * provider or by a gateway url, per monitor config
   *
   * @param  {string}          hash [description]
   * @return {Promise<string>}      [description]
   */
  private async ipfsCat(hash: string) : Promise<string> {
    return (this.ipfsProvider)
      ? this.ipfsProvider.cat(`/ipfs/${hash}`)
      : request(`${this.ipfsCatRequest}${hash}`);
  }

  // =======
  // Queue
  // =======

  /**
   * Adds item to a string indexed set the monitor will periodically iterate over,
   * seeking to match contract deployments and their associated metadata / source components.
   * Each item is timestamped so it can be removed when stale.
   *
   * @param {StringMap} queue string indexed set
   * @param {string}    key   index
   * @param {QueueItem} item
   */
  private addToQueue(queue: Queue, key:string, item: QueueItem) : void {
    if (queue[key] !== undefined)
      return;
    item.timestamp = new Date().getTime();
    queue[key] = item;
  }

  /**
   * Deletes items from a queue that have gone stale
   *
   * @param {StringMap} queue        string indexed set
   * @param {number}    maxAgeInSecs staleness criterion
   */
  private cleanupQueue(queue: Queue, maxAgeInSecs: number) : void {
    const toDelete : StringToBooleanMap = {};

    // getTime
    for (const key in queue) {
      if ((queue[key].timestamp as number + (maxAgeInSecs * 1000)) < new Date().getTime()) {
        toDelete[key] = true;
      }
    }
    for (const key in toDelete) {
      delete queue[key]
    }
  }

  // =======
  // Blocks
  // =======

  /**
   * Retrieves blocks for all chains
   */
  private retrieveBlocks() : void {
    for (const chain in this.chains) {
      this.retrieveBlocksInChain(chain);
    }
  }

  /**
   * Polls chain for new blocks, detecting contract deployments and
   * calling `retrieveBytecode` when one is discovered
   *
   * @param {any} chain [description]
   */
  private retrieveBlocksInChain(chain: any) : void {
    const _this = this;
    const web3 = this.chains[chain].web3;

    web3.eth.getBlockNumber((err: Error, newBlockNr: number) => {
      if (err) return;

      newBlockNr = Math.min(newBlockNr, _this.chains[chain].latestBlock + 4);

      for (; _this.chains[chain].latestBlock < newBlockNr; _this.chains[chain].latestBlock++) {
        const latest = _this.chains[chain].latestBlock;

        web3.eth.getBlock(latest, true, (err: Error, block: BlockTransactionObject) => {
          if (err || !block) {
            const latest = _this.chains[chain].latestBlock;
            log(`[BLOCKS] ${chain} Block ${latest} not available: ${err}`);
            return;
          }

          log(`[BLOCKS] ${chain} Processing Block ${block.number}:`);

          for (const i in block.transactions) {
            const t = block.transactions[i]
            if (t.to === null) {
              const address = ethers.utils.getContractAddress(t);
              log(`[BLOCKS] ${address}`);
              _this.retrieveCode(chain, address);
            }
          }
        })
      }
    })
  }

  /**
   * Fetches on-chain deployed bytecode and extracts its metadata hash. Add the item to
   * a metadata queue which will periodically query decentralized storage to discover whether
   * metadata exists at the discovered metadata hash address.
   *
   * @param {string} chain   ex: 'ropsten'
   * @param {string} address contract address
   */
  private retrieveCode(chain: string, address: string) : void {
    const _this = this;
    const web3 = this.chains[chain].web3;

    web3.eth.getCode(address, (err : Error, bytecode : string) => {
      if (err) return;

      try {
        const cborData = cborDecode(web3.utils.hexToBytes(bytecode))

        if (cborData && 'bzzr1' in cborData) {
          const metadataBzzr1 = web3.utils.bytesToHex(cborData['bzzr1']).slice(2);

          log(
            `[BLOCKS] Queueing retrieval of metadata for ${chain} ${address} ` +
            `: bzzr1 ${metadataBzzr1}`
          );

          _this.addToQueue(
            _this.chains[chain].metadataQueue,
            address,
            {bzzr1: metadataBzzr1}
          );

        } else if (cborData && 'ipfs' in cborData){
          const metadataIPFS = multihashes.toB58String(cborData['ipfs']);

          log(
            `[BLOCKS] Queueing retrieval of metadata for ${chain} ${address} ` +
            `: ipfs ${metadataIPFS}`
          )

          _this.addToQueue(
            _this.chains[chain].metadataQueue,
            address,
            {ipfs: metadataIPFS}
          );
        }
      } catch (error) { /* ignore */ }
    })
  }

  // =========
  // Metadata
  // =========

  /**
   * Retrieves metadata by chain. This data may be in decentralized storage - its storage
   * address has been queued after a contract deployment was detected by the retrieveBlocks
   * engine.
   */
  private retrieveMetadata() : void {
    for (const chain in this.chains) {
      this.retrieveMetadataInChain(chain);
    }
  }

  /**
   * Retrieves metadata from decentralized storage provider
   * for chain after deleting stale metadata queue items.
   * @param {string} chain ex: 'ropsten'
   */
  private retrieveMetadataInChain(chain: string) : void {
    log(`[METADATA] ${chain} Processing metadata queue...`);

    /// Try to retrieve metadata for one hour
    this.cleanupQueue(this.chains[chain].metadataQueue, 3600)
    for (const address in this.chains[chain].metadataQueue) {
      log(`[METADATA] ${address}`);

      // tslint:disable-next-line:no-floating-promises
      this.retrieveMetadataByStorageProvider(
        chain,
        address,
        this.chains[chain].metadataQueue[address]['bzzr1'],
        this.chains[chain].metadataQueue[address]['ipfs']
      );
    }
  }

  /**
   * Queries decentralized storage for metadata at the location specified by
   * hash embedded in the bytecode of a deployed contract. If metadata is discovered,
   * its sources are added to a source discovery queue. (Supports swarm:bzzr1 and ipfs)
   *
   * @param  {string}        chain         ex: 'ropsten'
   * @param  {string}        address       contract address
   * @param  {string}        metadataBzzr1 storage hash
   * @param  {string}        metadataIpfs  storage hash
   * @return {Promise<void>}
   */
  private async retrieveMetadataByStorageProvider(
    chain: string,
    address: string,
    metadataBzzr1: string | undefined,
    metadataIpfs: string | undefined
  ) : Promise<void> {
    let metadataRaw

    if (metadataBzzr1) {

      try {
        // TODO guard against too large files
        // TODO only write files after recompilation check?
        metadataRaw = await request(`${this.swarmGateway}/bzz-raw:/${metadataBzzr1}`);
        save(`${this.repository}/swarm/bzzr1/${metadataBzzr1}`, metadataRaw);
      } catch (error) { return }

    } else if (metadataIpfs){

      try {
        metadataRaw = await this.ipfsCat(metadataIpfs);
        save(`${this.repository}/ipfs/${metadataIpfs}`, metadataRaw.toString());
      } catch (error) { return }
    }

    log(`[METADATA] Got metadata for ${chain} ${address}`);
    save(`${this.repository}/contract/${chain}/${address}/metadata.json`, metadataRaw.toString());

    const metadata = JSON.parse(metadataRaw);
    delete this.chains[chain].metadataQueue[address];

    this.addToQueue(this.chains[chain].sourceQueue, address, {
      metadataRaw: metadataRaw.toString(),
      sources: metadata.sources
    });
  }


  // =======
  // Sources
  // =======

  /**
   * Queries decentralized storage for solidity files at the location specified by
   * a metadata sources manifest.
   */
  private retrieveSource() : void{
    for (const chain in this.chains) {
      this.retrieveSourceInChain(chain);
    }
  }

  /**
   * Retrieves solidity files by address from decentralized storage provider after
   * deleting stale source queue items.
   * @param {string} chain ex: 'ropsten'
   */
  private retrieveSourceInChain(chain: string) : void {
    log("[SOURCE] Processing source queue...");

    /// Try to retrieve source for five days.
    this.cleanupQueue(this.chains[chain].sourceQueue, 3600 * 24 * 5)

    for (const address in this.chains[chain].sourceQueue) {
      log(`[SOURCE] ${chain} ${address}`);
      this.retrieveSourceByAddress(
        chain,
        address,
        this.chains[chain].sourceQueue[address].sources
      );
    }
  }

  /**
   * Retrieves solidity files *for* a contract address from decentralized storage provider.
   *
   * @param {string} chain ex: 'ropsten'
   * @param {string} chain   [description]
   * @param {string} address [description]
   * @param {any}    sources [description]
   */
  private retrieveSourceByAddress(
    chain: string,
    address: string,
    sources: any
  ) : void {
    const _this = this;

    for (const sourceKey in sources) {
      for (const url of sources[sourceKey]['urls']) {

        // tslint:disable-next-line:no-floating-promises
        this.retrieveSwarmSource(chain, address, sourceKey, url);

        // tslint:disable-next-line:no-floating-promises
        this.retrieveIpfsSource(chain, address, sourceKey, url);
      }

      // TODO: is this deletable?
      const keccakPath = `${this.repository}/keccak256/${sources[sourceKey].keccak256}`;

      try {
        const data = read(keccakPath);
        this.sourceFound(chain, address, sourceKey, data.toString());

      } catch(err) { /* ignore */ }
    }
  }

  /**
   * Queries swarm for solidity file at metadata specified url and saves if found
   * @param  {string}        chain     ex: 'ropsten'
   * @param  {string}        address   contract address
   * @param  {string}        sourceKey file path or file name
   * @param  {string}        url       metadata specified swarm url
   * @return {Promise<void>}
   */
  private async retrieveSwarmSource(
    chain: string,
    address: string,
    sourceKey: string,
    url: string
  ) : Promise<void> {
    if (!url.startsWith('bzz-raw')) return;

    try {
      const source = await request(`${this.swarmGateway}${url}`);
      this.sourceFound(chain, address, sourceKey, source);
    } catch (error) {
      // ignore
    }
  }

  /**
   * Queries ipfs for solidity file at metadata specified url and saves if found.
   * @param  {string}        chain     ex: 'ropsten'
   * @param  {string}        address   contract address
   * @param  {string}        sourceKey file path or file name
   * @param  {string}        url       metadata specified ipfs url
   * @return {Promise<void>}
   */
  private async retrieveIpfsSource(
    chain: string,
    address: string,
    sourceKey: string,
    url: string
  ) : Promise<void> {

    if (!url.startsWith('dweb')) return;

    try {
      const source = await this.ipfsCat(url.split('dweb:/ipfs/')[1]);
      this.sourceFound(chain, address, sourceKey, source.toString());
    } catch (error) {
      // ignore
    }
  }

  /**
   * Writes discovered sources to repository under chain address and source key
   * qualified path:
   *
   * @example "repository/contract/ropsten/0xabc..defc/sources/Simple.sol"

   * @param {string} chain     ex: 'ropsten'
   * @param {string} address   contract address
   * @param {string} sourceKey file path or file name
   * @param {string} source    solidity file
   */
  private sourceFound(
    chain: string,
    address: string,
    sourceKey: string,
    source: string
  ) : void {

    const pathSanitized : string = sourceKey
      .replace(/[^a-z0-9_.\/-]/gim, "_")
      .replace(/(^|\/)[.]+($|\/)/, '_');

    save(`${this.repository}/contract/${chain}/${address}/sources/${pathSanitized}`, source);

    delete this.chains[chain].sourceQueue[address].sources[sourceKey]

    log(`[SOURCES] ${chain} ${address} Sources left to be retrieved: `);
    log(Object.keys(this.chains[chain].sourceQueue[address].sources));

    if (Object.keys(this.chains[chain].sourceQueue[address].sources).length == 0) {
      delete this.chains[chain].sourceQueue[address];
    }
  }
}
