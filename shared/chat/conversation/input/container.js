// @flow
import * as Constants from '../../../constants/chat'
import * as Creators from '../../../actions/chat/creators'
import * as ChatGen from '../../../actions/chat-gen'
import {commonConversationMemberStatus} from '../../../constants/types/flow-types-chat'
import HiddenString from '../../../util/hidden-string'
import Input from '.'
import ChannelPreview from './channel-preview'
import {
  branch,
  compose,
  renderComponent,
  withHandlers,
  withState,
  lifecycle,
  connect,
  type TypedState,
} from '../../../util/container'
import {navigateAppend, navigateUp, navigateTo} from '../../../actions/route-tree'
import throttle from 'lodash/throttle'
import {createSelector} from 'reselect'
import {type OwnProps} from './container'

const conversationStateSelector = (state: TypedState) => {
  const selectedConversationIDKey = Constants.getSelectedConversation(state)
  return selectedConversationIDKey
    ? state.chat.getIn(['conversationStates', selectedConversationIDKey])
    : null
}

const editingMessageSelector = (state: TypedState) => state.chat.get('editingMessage')

const ownPropsSelector = (_, {focusInputCounter}: OwnProps) => ({focusInputCounter})

const stateDependentProps = createSelector(
  [
    Constants.getSelectedConversation,
    conversationStateSelector,
    Constants.getSelectedRouteState,
    editingMessageSelector,
    Constants.getSelectedInbox,
  ],
  (selectedConversationIDKey, conversationState, routeState, editingMessage, inbox) => {
    let isLoading = true
    let typing = []

    if (selectedConversationIDKey !== Constants.nothingSelected) {
      if (!Constants.isPendingConversationIDKey(selectedConversationIDKey || '')) {
        if (conversationState) {
          isLoading = !conversationState.isLoaded
          typing = conversationState.typing.toArray()
        }
      } else {
        // A conversation can't be loading if it's pending -- it doesn't exist
        // yet and we need to allow creating it.
        isLoading = false
      }
    }

    const isPreview = (inbox && inbox.memberStatus) === commonConversationMemberStatus.preview

    return {
      channelName: inbox && inbox.channelname,
      editingMessage,
      isLoading,
      isPreview,
      defaultText: (routeState && routeState.get('inputText', new HiddenString('')).stringValue()) || '',
      selectedConversationIDKey,
      typing,
      teamname: inbox && inbox.teamname,
    }
  }
)

const mapStateToProps = createSelector([stateDependentProps, ownPropsSelector], (stateProps, ownProps) => ({
  ...stateProps,
  ...ownProps,
}))

const mapDispatchToProps = (dispatch: Dispatch, ownProps: OwnProps) => ({
  onAttach: (selectedConversation, inputs: Array<Constants.AttachmentInput>) => {
    dispatch(
      navigateAppend([
        {props: {conversationIDKey: selectedConversation, inputs}, selected: 'attachmentInput'},
      ])
    )
  },
  onEditMessage: (message: Constants.Message, body: string) => {
    dispatch(ChatGen.createEditMessage({message, text: new HiddenString(body)}))
  },
  onPostMessage: (selectedConversation, text) =>
    selectedConversation &&
    dispatch(
      ChatGen.createPostMessage({conversationIDKey: selectedConversation, text: new HiddenString(text)})
    ),
  onShowEditor: (message: Constants.Message) => {
    dispatch(ChatGen.createShowEditor({message}))
  },
  onStoreInputText: (selectedConversation: Constants.ConversationIDKey, inputText: string) =>
    dispatch(Creators.setSelectedRouteState(selectedConversation, {inputText: new HiddenString(inputText)})),
  onUpdateTyping: (selectedConversation: Constants.ConversationIDKey, typing: boolean) => {
    dispatch(ChatGen.createUpdateTyping({conversationIDKey: selectedConversation, typing}))
  },
  onJoinChannel: (selectedConversation: Constants.ConversationIDKey) => {
    dispatch(ChatGen.createJoinConversation({conversationIDKey: selectedConversation}))
  },
  onLeaveChannel: (selectedConversation: Constants.ConversationIDKey, teamname: string) => {
    dispatch(ChatGen.createLeaveConversation({conversationIDKey: selectedConversation}))
    dispatch(navigateUp())
    if (ownProps.previousPath) {
      dispatch(navigateTo(ownProps.previousPath))
    }
  },
})

// TODO type-recompose: fix when recompose types properly
const mergeProps = (stateProps, dispatchProps, ownProps: OwnProps) => {
  const updateTyping = (typing: boolean) => {
    if (stateProps.selectedConversationIDKey) {
      dispatchProps.onUpdateTyping(stateProps.selectedConversationIDKey, typing)
    }
  }
  const wrappedTyping = throttle(updateTyping, 5000)

  return {
    ...stateProps,
    ...dispatchProps,
    ...ownProps,
    onAttach: (inputs: Array<Constants.AttachmentInput>) =>
      dispatchProps.onAttach(stateProps.selectedConversationIDKey, inputs),
    onEditLastMessage: ownProps.onEditLastMessage,
    onPostMessage: text => {
      dispatchProps.onPostMessage(stateProps.selectedConversationIDKey, text)
      ownProps.onScrollDown()
    },
    onStoreInputText: (inputText: string) => {
      if (stateProps.selectedConversationIDKey) {
        // only write if we're in a convo
        dispatchProps.onStoreInputText(stateProps.selectedConversationIDKey, inputText)
      }
    },
    onUpdateTyping: (typing: boolean) => {
      if (!typing) {
        // Update the not-typing status immediately, even if we're throttled.
        wrappedTyping.cancel()
        updateTyping(typing)
      } else {
        wrappedTyping(typing)
      }
    },
    onJoinChannel: () => dispatchProps.onJoinChannel(stateProps.selectedConversationIDKey),
    onLeaveChannel: () =>
      dispatchProps.onLeaveChannel(stateProps.selectedConversationIDKey, stateProps.teamname),
  }
}

export default compose(
  connect(mapStateToProps, mapDispatchToProps, mergeProps),
  branch(props => props.isPreview, renderComponent(ChannelPreview)),
  withState('text', '_setText', props => props.defaultText || ''),
  withState('mentionPopupOpen', 'setMentionPopupOpen', false),
  withState('mentionFilter', 'setMentionFilter', ''),
  withHandlers(props => {
    let input
    // mutable value to store the latest text synchronously
    let _syncTextValue = ''
    return {
      inputClear: props => () => {
        input && input.setNativeProps({text: ''})
      },
      inputFocus: props => () => input && input.focus(),
      inputBlur: props => () => input && input.blur(),
      inputSelections: props => () => (input && input.selections()) || {},
      inputSetRef: props => i => {
        input = i
      },
      setText: props => (nextText: string) => {
        _syncTextValue = nextText
        return props._setText(nextText)
      },
      inputValue: props => () => _syncTextValue || '',
    }
  }),
  lifecycle({
    componentDidUpdate: function(prevProps) {
      if (this.props.focusInputCounter !== prevProps.focusInputCounter) {
        this.props.inputFocus()
      }
    },
    componentWillUnmount: function() {
      this.props.onStoreInputText(this.props.text)
    },
    componentWillReceiveProps: function(nextProps) {
      if (
        this.props.selectedConversationIDKey &&
        this.props.selectedConversationIDKey !== nextProps.selectedConversationIDKey
      ) {
        this.props.onStoreInputText(this.props.text)
        // withState won't get called again if props changes!
        this.props.setText(nextProps.defaultText)
      }
    },
  })
)(Input)
