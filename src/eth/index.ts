
import {
  isAssetValid,
  assetToCollectible,
  creationEventToCollectible,
  transferEventToCollectible,
  isFromNullAddress
} from 'eth/helpers'
import {
  OpenSeaAsset,
  OpenSeaAssetExtended,
  OpenSeaEvent,
  OpenSeaEventExtended
} from 'eth/types'
import {Collectible, CollectibleState, CollectionInfo} from 'utils/types'

const OPENSEA_API_URL = 'https://api.opensea.io/api/v1'

type AssetEventData = { asset_events: OpenSeaEvent[] }
type AssetEventResult = PromiseSettledResult<AssetEventData>
type AssetEventFulfilledResult = PromiseFulfilledResult<AssetEventData>

const parseAssetEventResults = (results: AssetEventResult[], wallets: string[]) => {
  return results
    .map((result, i) => ({ result, wallet: wallets[i] }))
    .filter(({ result }) => result.status === 'fulfilled')
    .map(
      ({ result, wallet }) =>
        (result as AssetEventFulfilledResult).value.asset_events?.map(event => ({
          ...event,
          asset: { ...event.asset, wallet },
          wallet
        })) || []
    )
    .flat()
}

type AssetData = { assets: OpenSeaAsset[] }
type AssetResult = PromiseSettledResult<AssetData>
type AssetFulfilledResult = PromiseFulfilledResult<AssetData>

const parseAssetResults = (results: AssetResult[], wallets: string[]) => {
  return results
    .map((result, i) => ({ result, wallet: wallets[i] }))
    .filter(({ result }) => result.status === 'fulfilled')
    .map(
      ({ result, wallet }) =>
        (result as AssetFulfilledResult).value.assets?.map(asset => ({ ...asset, wallet })) || []
    )
    .flat()
}

export type OpenSeaClientProps = {
  apiEndpoint?: string
  apiKey?: string
  assetLimit?: number
  eventLimit?: number
}

export class OpenSeaClient {
  readonly url: string = OPENSEA_API_URL
  readonly apiKey: string = ''
  readonly assetLimit: number = 50
  readonly eventLimit: number = 300

  constructor(props?: OpenSeaClientProps) {
    this.url = props?.apiEndpoint ?? this.url
    this.apiKey = props?.apiKey ?? this.apiKey
    this.assetLimit = props?.assetLimit ?? this.assetLimit
    this.eventLimit = props?.eventLimit ?? this.eventLimit
  }

  private sendGetRequest = async (url = '') => {
    // Default options are marked with *
    const response = await fetch(url, {
      method: 'GET', // *GET, POST, PUT, DELETE, etc.
      mode: 'cors', // no-cors, *cors, same-origin
      cache: 'no-cache', // *default, no-cache, reload, force-cache, only-if-cached
      credentials: 'same-origin', // include, *same-origin, omit
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': this.apiKey
      },
      redirect: 'follow', // manual, *follow, error
      referrerPolicy: 'no-referrer', // no-referrer, *no-referrer-when-downgrade, origin, origin-when-cross-origin, same-origin, strict-origin, strict-origin-when-cross-origin, unsafe-url
    });
    return response.json(); // parses JSON response into native JavaScript objects
  }

  private getTransferredCollectiblesForWallet = async (
    wallet: string,
    limit = this.eventLimit
  ): Promise<AssetEventData> => {
    return this.sendGetRequest(`${this.url}/events?account_address=${wallet}&limit=${limit}&event_type=transfer&only_opensea=false`).then(r => r);
  }

  private getTransferredCollectiblesForMultipleWallets = async (
    wallets: string[],
    limit = this.eventLimit
  ): Promise<OpenSeaEventExtended[]> => {
    return Promise.allSettled(
      wallets.map(wallet => this.getTransferredCollectiblesForWallet(wallet, limit))
    ).then(results => parseAssetEventResults(results, wallets))
  }

  private getCreatedCollectiblesForWallet = async (
    wallet: string,
    limit = this.eventLimit
  ): Promise<AssetEventData> => {
    return this.sendGetRequest(`${this.url}/events?account_address=${wallet}&limit=${limit}&event_type=created&only_opensea=false`).then(r => r);

  }

  private getCreatedCollectiblesForMultipleWallets = async (
    wallets: string[],
    limit = this.eventLimit
  ): Promise<OpenSeaEventExtended[]> => {
    return Promise.allSettled(
      wallets.map(wallet => this.getCreatedCollectiblesForWallet(wallet, limit))
    ).then(results => parseAssetEventResults(results, wallets))
  }

  private getCollectiblesForWallet = async(
    wallet: string,
    limit = this.assetLimit
  ): Promise<AssetData> => {
    return this.sendGetRequest(`${this.url}/assets?owner=${wallet}&limit=${limit}`).then(r => r);
  }

  private getCollectiblesForMultipleWallets = async (
    wallets: string[],
    limit = this.assetLimit
  ): Promise<OpenSeaAssetExtended[]> => {
    return Promise.allSettled(
      wallets.map(wallet => this.getCollectiblesForWallet(wallet, limit))
    ).then(results => parseAssetResults(results, wallets))
  }

  public getCollection = async (assetContractAddress: string, tokenId: string): Promise<CollectionInfo> => {
    const result = await this.sendGetRequest(`${this.url}/asset/${assetContractAddress}/${tokenId}`);
    return {
      name: result?.collection?.name || '',
      slug: result?.collection?.slug || '',
      imageUrl: result?.collection?.image_url || '',
      contractAddress: (result?.collection?.primary_asset_contracts || []).reduce((prev: any, current: any) =>  (prev?.address || '') + `${prev?.address ? ',' : ''}` + (current?.address || ''), "") || '',
      safeListRequestStatus: result?.collection?.safelist_request_status,
      openListingCount: 0,
      closeListingCount: 0,
      openLoanCount: 0,
      closeLoanCount: 0
    }
  }

  public getAssetOwner = async (assetContractAddress: string, tokenId: string): Promise<string> => {
    const result = await this.sendGetRequest(`${this.url}/asset/${assetContractAddress}/${tokenId}`);
    return result?.owner?.address || null;
  }

  public getAllCollectibles = async (wallets: string[]): Promise<CollectibleState> => {
    return Promise.all([
      this.getCollectiblesForMultipleWallets(wallets),
      this.getCreatedCollectiblesForMultipleWallets(wallets),
      this.getTransferredCollectiblesForMultipleWallets(wallets)
    ]).then(async ([assets, creationEvents, transferEvents]) => {
      const filteredAssets = assets.filter(
        asset => asset && isAssetValid(asset)
      )
      const collectibles = await Promise.all(
        filteredAssets.map(async asset => await assetToCollectible(asset))
      )
      const collectiblesMap: {
        [key: string]: Collectible
      } = collectibles.reduce(
        (acc, curr) => ({
          ...acc,
          [curr.id]: curr
        }),
        {}
      )
      const ownedCollectibleKeySet = new Set(Object.keys(collectiblesMap))

      // Handle transfers from NullAddress as if they were created events
      const firstOwnershipTransferEvents = transferEvents
        .filter(
          event =>
            event?.asset &&
            isAssetValid(event.asset) &&
            isFromNullAddress(event)
        )
        .reduce((acc: { [key: string]: OpenSeaEventExtended }, curr) => {
          const { token_id, asset_contract } = curr.asset
          const id = `${token_id}:::${asset_contract?.address ?? ''}`
          if (
            acc[id] &&
            acc[id].created_date.localeCompare(curr.created_date) > 0
          ) {
            return acc
          }
          return { ...acc, [id]: curr }
        }, {})
      await Promise.all(
        Object.entries(firstOwnershipTransferEvents).map(async entry => {
          const [id, event] = entry
          if (ownedCollectibleKeySet.has(id)) {
            collectiblesMap[id] = {
              ...collectiblesMap[id],
              dateLastTransferred: event.created_date
            }
          } else {
            ownedCollectibleKeySet.add(id)
            collectiblesMap[id] = await transferEventToCollectible(event, false)
          }
          return event
        })
      )

      // Handle created events
      await Promise.all(
        creationEvents
          .filter(event => event?.asset && isAssetValid(event.asset))
          .map(async event => {
            const { token_id, asset_contract } = event.asset
            const id = `${token_id}:::${asset_contract?.address ?? ''}`
            if (!ownedCollectibleKeySet.has(id)) {
              collectiblesMap[id] = await creationEventToCollectible(event)
              ownedCollectibleKeySet.add(id)
            }
            return event
          })
      )

      // Handle transfers
      const latestTransferEventsMap = transferEvents
        .filter(
          event =>
            event?.asset &&
            isAssetValid(event.asset) &&
            !isFromNullAddress(event)
        )
        .reduce((acc: { [key: string]: OpenSeaEventExtended }, curr) => {
          const { token_id, asset_contract } = curr.asset
          const id = `${token_id}:::${asset_contract?.address ?? ''}`
          if (
            acc[id] &&
            acc[id].created_date.localeCompare(curr.created_date) > 0
          ) {
            return acc
          }
          return { ...acc, [id]: curr }
        }, {})
      await Promise.all(
        Object.values(latestTransferEventsMap).map(async event => {
          const { token_id, asset_contract } = event.asset
          const id = `${token_id}:::${asset_contract?.address ?? ''}`
          if (ownedCollectibleKeySet.has(id)) {
            collectiblesMap[id] = {
              ...collectiblesMap[id],
              dateLastTransferred: event.created_date
            }
          } else if (wallets.includes(event.to_account.address)) {
            ownedCollectibleKeySet.add(id)
            collectiblesMap[id] = await transferEventToCollectible(event)
          }
          return event
        })
      )

      return Object.values(collectiblesMap).reduce(
        (result, collectible) => ({
          ...result,
          [collectible.wallet]: (result[collectible.wallet] || []).concat([
            collectible
          ])
        }),
        {} as CollectibleState
      )
    })
  }
}
