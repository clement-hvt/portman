import {CollectionDefinition, ItemDefinition, ItemGroupDefinition} from 'postman-collection'
import { PostmanApiCollectionResult, PostmanApiService, PostmanApiWorkspaceResult } from './'
import { PostmanRepo } from './PostmanRepo'
import * as Either from "fp-ts/Either";

type PostmanCache = {
  collections: PostmanApiCollectionResult[]
  workspaces: PostmanApiWorkspaceResult[]
}

export class PostmanSyncService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public state: any
  public portmanCollection: CollectionDefinition
  public collectionName?: string

  postmanApi: PostmanApiService
  postmanUid?: string
  postmanWorkspaceName?: string

  postmanRepo: PostmanRepo
  cacheFile: string
  cache: PostmanCache
  postmanFastSync: boolean
  postmanRefreshCache: boolean

  constructor({
    postmanApi = new PostmanApiService(),
    portmanCollection,
    postmanUid,
    postmanWorkspaceName,
    collectionName,
    cacheFile,
    postmanFastSync,
    postmanRefreshCache
  }: {
    portmanCollection: CollectionDefinition
    postmanApi?: PostmanApiService
    postmanUid?: string
    postmanWorkspaceName?: string
    collectionName?: string
    cacheFile?: string
    postmanFastSync?: boolean
    postmanRefreshCache?: boolean
  }) {
    this.postmanApi = postmanApi
    this.postmanUid = postmanUid
    this.postmanWorkspaceName = postmanWorkspaceName

    this.cacheFile = cacheFile || `${process.cwd()}/tmp/.portman.cache.json`
    this.postmanRepo = new PostmanRepo(this.cacheFile, this.postmanApi)

    this.portmanCollection = portmanCollection
    this.collectionName = collectionName || (portmanCollection?.info?.name as string)

    this.postmanFastSync = postmanFastSync ?? false
    this.postmanRefreshCache = postmanRefreshCache ?? false

    // Prevent collection delete, when postmanUid is set
    if (this.postmanUid) {
      this.postmanFastSync = false
    }

    this.state = {}

    if (!this.collectionName) {
      throw new Error(
        `Postman collection name is required. Please ensure your OpenAPI document has title.`
      )
    }
  }

  public async sync(): Promise<string> {
    await this.postmanRepo.initCache(this.postmanRefreshCache, this.postmanRefreshCache)
    await this.validateState()

    const { shouldCreate, shouldUpdate } = this.state

    if (this.postmanFastSync) {
      const deleteResponse = await this.deleteCollection()
      const { status } = JSON.parse(deleteResponse)
      if (status === 'fail') {
        return deleteResponse
      }
    }

    if ((shouldCreate && !shouldUpdate) || this.postmanFastSync) {
      const collCreate = await this.createCollection()
      await this.postmanRepo.initCache(true, false)
      return collCreate
    }

    return await this.updateCollection()
  }

  async validateState(): Promise<void> {
    if (!this.portmanCollection) {
      throw new Error('No collection provided')
    }

    const { state } = this
    state.collectionName = this.collectionName
    state.workspaceId = await this.lookupWorkspaceId()
    state.shouldCreate = this.shouldCreate()
    state.shouldUpdate = this.shouldUpdate()

    const { shouldCreate, shouldUpdate } = this.state

    if (!shouldCreate && !shouldUpdate) {
      console.log(this.state)
      throw new Error('Sync is in an invalid state')
    }

    if (state.shouldCreate) {
      this.postmanUid = undefined
      this.state.postmanUid = undefined
    }
  }

  shouldCreate(): boolean {
    if (this.postmanUid && this.shouldUpdate()) return false

    const knownCollection = this.lookupCollection()

    if (!knownCollection) {
      return true
    }

    if (this.state.workspaceId) {
      return !this.existsInWorkspace()
    }

    if (knownCollection) {
      this.postmanUid = knownCollection.uid
      this.state.postmanUid = knownCollection.uid
    }

    return false
  }

  shouldUpdate(): boolean {
    const knownCollection = this.lookupCollection()

    if (knownCollection) {
      this.postmanUid = knownCollection.uid
      this.state.postmanUid = knownCollection.uid
    }

    if (this.state.workspaceId) {
      return this.existsInWorkspace()
    }

    return !!this.postmanUid && !!knownCollection
  }

  lookupCollection(): PostmanApiCollectionResult | undefined {
    const knownCollection = this.postmanUid
      ? this.postmanRepo.findCollectionByUid(this.postmanUid as string)
      : this.postmanRepo.findCollectionByName(this.collectionName as string)

    return knownCollection
  }

  existsInWorkspace(): boolean {
    const workspaceCollection = this.state.workspaceId
      ? (this.postmanRepo.findWorkspaceCollectionByName(
          this.collectionName as string
        ) as Partial<PostmanApiCollectionResult>)
      : undefined

    if (workspaceCollection?.uid) {
      this.postmanUid = workspaceCollection.uid
      this.state.postmanUid = workspaceCollection.uid
    }

    return !!this.state.workspaceId && !!workspaceCollection
  }

  async lookupWorkspaceId(): Promise<string | undefined> {
    if (!this.postmanWorkspaceName) return undefined

    const workspaceId = this.postmanRepo.findWorkspaceByName(this.postmanWorkspaceName)?.id

    if (!workspaceId) {
      throw new Error(`Could not find workspace with name ${this.postmanWorkspaceName}`)
    }

    await this.postmanRepo.getWorkspace(workspaceId)

    return workspaceId
  }

  async createCollection(): Promise<string> {
    const {
      state: { workspaceId },
      portmanCollection
    } = this
    return this.postmanApi.createCollection(portmanCollection, workspaceId)
  }

  async updateCollection(): Promise<string> {
    const {
      state: { postmanUid, workspaceId },
      portmanCollection
    } = this
    console.log('update')
    await this.synchronizeCollectionId(postmanUid)
    console.log(this.portmanCollection)
    return this.postmanApi.updateCollection(portmanCollection, postmanUid, workspaceId)
  }

  async deleteCollection(): Promise<string> {
    const {
      state: { postmanUid }
    } = this
    return this.postmanApi.deleteCollection(postmanUid)
  }

  async synchronizeCollectionId(postmanUid: string) {
    return new Promise(async (resolve, reject) => {
      const collectionResult = await this.postmanApi.getCollection(postmanUid);

      if (Either.isLeft(collectionResult)) {
        throw collectionResult.left
      }

      let postmanCollection: CollectionDefinition = collectionResult.right

      if (this.portmanCollection.item && ("item" in this.portmanCollection && postmanCollection && this.portmanCollection.item && postmanCollection.item)) {
        postmanCollection.item.forEach(postmanItem => {

          // @ts-ignore
          let commonItem:(ItemGroupDefinition | ItemDefinition | undefined) = this.portmanCollection.item.find(portmanItem => portmanItem.name === postmanItem.name)

          if (commonItem && "item" in commonItem) {
            commonItem.id = postmanItem.id

            if("item" in postmanItem && postmanItem.item && commonItem.item) {
              postmanItem.item.forEach(postmanSubRequest => {
                // @ts-ignore
                let commonSubItem = commonItem.item.find(portmanSubRequest => postmanSubRequest.name === portmanSubRequest.name)
                commonSubItem.id = postmanSubRequest.id
              })
            }
          }
        })
        resolve(postmanCollection)
      } else {
        reject(`Portman/Postman collection does not contain any items.`)
      }


    })

  }
}
