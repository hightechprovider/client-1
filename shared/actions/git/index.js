// @flow
import * as ConfigGen from '../../actions/config-gen'
import * as Constants from '../../constants/git'
import * as GitGen from '../../actions/git-gen'
import * as Entities from '../entities'
import * as I from 'immutable'
import * as RPCTypes from '../../constants/types/flow-types'
import * as RouteTreeConstants from '../../constants/route-tree'
import * as Saga from '../../util/saga'
import * as SettingsConstants from '../../constants/settings'
import * as Tabs from '../../constants/tabs'
import moment from 'moment'
import {isMobile} from '../../constants/platform'
import {navigateTo} from '../route-tree'

function* _loadGit(action: GitGen.LoadGitPayload): Saga.SagaGenerator<any, any> {
  yield Saga.put(GitGen.createSetError({error: null}))
  yield Saga.put(GitGen.createSetLoading({loading: true}))

  try {
    const results: Array<RPCTypes.GitRepoResult> = yield Saga.call(RPCTypes.gitGetAllGitMetadataRpcPromise, {
      param: {},
    }) || []

    let idToInfo = {}

    for (let i = 0; i < results.length; i++) {
      const repoResult = results[i]
      if (repoResult.state === RPCTypes.gitGitRepoResultState.ok && repoResult.ok) {
        const r: RPCTypes.GitRepoInfo = repoResult.ok
        if (!r.folder.private) {
          // Skip public repos
          continue
        }
        const teamname = r.folder.folderType === RPCTypes.favoriteFolderType.team ? r.folder.name : null
        idToInfo[r.globalUniqueID] = Constants.makeGitInfo({
          canDelete: r.canDelete,
          devicename: r.serverMetadata.lastModifyingDeviceName,
          id: r.globalUniqueID,
          lastEditTime: moment(r.serverMetadata.mtime).fromNow(),
          lastEditUser: r.serverMetadata.lastModifyingUsername,
          name: r.localMetadata.repoName,
          teamname,
          url: r.repoUrl,
        })
      } else {
        let errStr: string = 'unknown'
        if (repoResult.state === RPCTypes.gitGitRepoResultState.err && repoResult.err) {
          errStr = repoResult.err
        }
        yield Saga.put(
          ConfigGen.createGlobalError({
            globalError: new Error(`Git repo error: ${errStr}`),
          })
        )
      }
    }

    yield Saga.put(Entities.replaceEntity(['git'], I.Map({idToInfo: I.Map(idToInfo)})))
  } finally {
    yield Saga.put(GitGen.createSetLoading({loading: false}))
  }
}

// reset errors and set loading, make a call and either go back to the root or show an error
function* _createDeleteHelper(theCall: *): Generator<any, void, any> {
  yield Saga.put.resolve(GitGen.createSetError({error: null}))
  yield Saga.put.resolve(GitGen.createSetLoading({loading: true}))
  try {
    yield theCall
    yield Saga.put(navigateTo(isMobile ? [Tabs.settingsTab, SettingsConstants.gitTab] : [Tabs.gitTab], []))
    yield Saga.put.resolve(GitGen.createSetLoading({loading: false}))
    yield Saga.put(GitGen.createLoadGit())
  } catch (err) {
    yield Saga.put(GitGen.createSetError({error: err}))
    yield Saga.put.resolve(GitGen.createSetLoading({loading: false}))
  } finally {
    // just in case
    yield Saga.put.resolve(GitGen.createSetLoading({loading: false}))
  }
}

function* _createPersonalRepo(action: GitGen.CreatePersonalRepoPayload): Saga.SagaGenerator<any, any> {
  yield Saga.call(
    _createDeleteHelper,
    Saga.call(RPCTypes.gitCreatePersonalRepoRpcPromise, {
      param: {
        repoName: action.payload.name,
      },
    })
  )
}

function* _createTeamRepo(action: GitGen.CreateTeamRepoPayload): Saga.SagaGenerator<any, any> {
  yield Saga.call(
    _createDeleteHelper,
    Saga.call(RPCTypes.gitCreateTeamRepoRpcPromise, {
      param: {
        notifyTeam: action.payload.notifyTeam,
        repoName: action.payload.name,
        teamName: {
          parts: action.payload.teamname.split('.'),
        },
      },
    })
  )
}

function* _deletePersonalRepo(action: GitGen.DeletePersonalRepoPayload): Saga.SagaGenerator<any, any> {
  yield Saga.call(
    _createDeleteHelper,
    Saga.call(RPCTypes.gitDeletePersonalRepoRpcPromise, {
      param: {
        repoName: action.payload.name,
      },
    })
  )
}

function* _deleteTeamRepo(action: GitGen.DeleteTeamRepoPayload): Saga.SagaGenerator<any, any> {
  yield Saga.call(
    _createDeleteHelper,
    Saga.call(RPCTypes.gitDeleteTeamRepoRpcPromise, {
      param: {
        notifyTeam: action.payload.notifyTeam,
        repoName: action.payload.name,
        teamName: {
          parts: action.payload.teamname.split('.'),
        },
      },
    })
  )
}

function* _setLoading(action: GitGen.SetLoadingPayload): Saga.SagaGenerator<any, any> {
  yield Saga.put(Entities.replaceEntity(['git'], I.Map([['loading', action.payload.loading]])))
}

function* _setError(action: GitGen.SetErrorPayload): Saga.SagaGenerator<any, any> {
  yield Saga.put(Entities.replaceEntity(['git'], I.Map([['error', action.payload.error]])))
}

const _badgeAppForGit = (action: GitGen.BadgeAppForGitPayload) =>
  Saga.put(Entities.replaceEntity(['git'], I.Map([['isNew', I.Set(action.payload.ids)]])))

let _wasOnGitTab = false
const _onTabChange = (action: RouteTreeConstants.SwitchTo) => {
  // on the git tab?
  const list = I.List(action.payload.path)
  const root = list.first()

  if (root === Tabs.gitTab) {
    _wasOnGitTab = true
  } else if (_wasOnGitTab) {
    _wasOnGitTab = false
    // clear badges
    return Saga.call(RPCTypes.gregorDismissCategoryRpcPromise, {
      param: {
        category: 'new_git_repo',
      },
    })
  }

  return null
}

function* _handleIncomingGregor(action: GitGen.HandleIncomingGregorPayload): Saga.SagaGenerator<any, any> {
  const msgs = action.payload.messages.map(msg => JSON.parse(msg.body))
  for (let body of msgs) {
    const needsLoad = ['delete', 'create', 'update'].includes(body.action)
    if (needsLoad) {
      yield Saga.put(GitGen.createLoadGit())
      return // Note: remove (or replace with `continue`) if any other actions may need dispatching
    }
  }
}

function* gitSaga(): Saga.SagaGenerator<any, any> {
  yield Saga.safeTakeLatest(GitGen.loadGit, _loadGit)
  yield Saga.safeTakeEvery(GitGen.createPersonalRepo, _createPersonalRepo)
  yield Saga.safeTakeEvery(GitGen.createTeamRepo, _createTeamRepo)
  yield Saga.safeTakeEvery(GitGen.deletePersonalRepo, _deletePersonalRepo)
  yield Saga.safeTakeEvery(GitGen.deleteTeamRepo, _deleteTeamRepo)
  yield Saga.safeTakeLatest(GitGen.setLoading, _setLoading)
  yield Saga.safeTakeLatest(GitGen.setError, _setError)
  yield Saga.safeTakeEveryPure(GitGen.badgeAppForGit, _badgeAppForGit)
  yield Saga.safeTakeEvery(GitGen.handleIncomingGregor, _handleIncomingGregor)
  yield Saga.safeTakeEveryPure(RouteTreeConstants.switchTo, _onTabChange)
}

export default gitSaga
