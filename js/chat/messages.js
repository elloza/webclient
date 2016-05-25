var Message = function(chatRoom, messagesBuff, vals) {
    var self = this;

    self.chatRoom = chatRoom;
    self.messagesBuff = messagesBuff;


    MegaDataObject.attachToExistingJSObject(
        self,
        {
            'userId': true,
            'messageId': true,

            'keyid': true,

            'message': true,

            'textContents': false,

            'delay': true,

            'orderValue': false,
            'updated': false,
            'sent': Message.STATE.NOT_SENT,
            'deleted': false,
            'revoked': false,
        },
        true,
        vals
    );

    self._parent = chatRoom.messagesBuff;
};

Message._mockupNonLoadedMessage = function(msgId, msg, orderValueIfNotFound) {
    if (!msg) {
        return {
            messageId: msgId,
            orderValue: orderValueIfNotFound
        };
    }
    else {
        return msg;
    }
};

Message.prototype.getState = function() {
    var self = this;
    var mb = self.messagesBuff;

    if (!self.orderValue) {
        return Message.STATE.NULL;
    }

    var lastSeenMessage = Message._mockupNonLoadedMessage(mb.lastSeen, mb.messages[mb.lastSeen], 0);

    if (self.userId === u_handle) {
        // can be NOT_SENT, SENT, DELIVERED and DELETED
        if (self.deleted === true) {
            return Message.STATE.DELETED;
        }
        else if (self.sent === Message.STATE.NOT_SENT) {
            return Message.STATE.NOT_SENT;
        }
        else if (self.sent === Message.STATE.SENT) {
            return Message.STATE.SENT;
        }
        else if (self.sent === Message.STATE.NOT_SENT_EXPIRED) {
            return Message.STATE.NOT_SENT_EXPIRED;
        }
        else if (self.sent === true) {
            return Message.STATE.DELIVERED;
        }
        else {
            console.error("Was not able to determinate state from pointers [1].");
            return -1;
        }
    }
    else {
        // can be NOT_SEEN, SEEN and DELETED
        if (self.deleted === true) {
            return Message.STATE.DELETED;
        }
        else if (self.orderValue > lastSeenMessage.orderValue) {
            return Message.STATE.NOT_SEEN;
        }
        else if (self.orderValue <= lastSeenMessage.orderValue) {
            return Message.STATE.SEEN;
        }

        else {
            console.error("Was not able to determinate state from pointers [2].");
            return -2;
        }
    }
};

Message.STATE = {
    'NULL': 0,
    'NOT_SEEN': 1,
    'SENT': 10, /* SENT = CONFIRMED */
    'NOT_SENT_EXPIRED': 14,
    'NOT_SENT': 20, /* NOT_SENT = PENDING */
    'DELIVERED': 30,
    'SEEN': 40,
    'DELETED': 8,
};
Message.MANAGEMENT_MESSAGE_TYPES = {
    "MANAGEMENT": "\0",
    "ATTACHMENT": "\x10",
    "REVOKE_ATTACHMENT": "\x11",
    "CONTACT": "\x12",
};


Message.prototype.isManagement = function() {
    if (!this.textContents) {
        return false;
    }
    return this.textContents.substr(0, 1) === Message.MANAGEMENT_MESSAGE_TYPES.MANAGEMENT;
};
Message.prototype.isRenderableManagement = function() {
    if (!this.textContents) {
        return false;
    }
    return this.textContents.substr(0, 1) === Message.MANAGEMENT_MESSAGE_TYPES.MANAGEMENT && (
            this.textContents.substr(1, 1) === Message.MANAGEMENT_MESSAGE_TYPES.ATTACHMENT ||
            this.textContents.substr(1, 1) === Message.MANAGEMENT_MESSAGE_TYPES.CONTACT
        );
};

/**
 * To be used when showing a summary of the text message (e.g. a text only repres.)
 */
Message.prototype.getManagementMessageSummaryText = function() {
    if (!this.isManagement()) {
        return this.textContents;
    }
    if (this.textContents.substr(1, 1) === Message.MANAGEMENT_MESSAGE_TYPES.ATTACHMENT) {
        var nodes = JSON.parse(this.textContents.substr(2, this.textContents.length));
        if (nodes.length === 1) {
            return __("Attached: %s").replace("%s", nodes[0].name);
        }
        else {
            return __("Attached %s files.").replace("%s", nodes.length);
        }
    }
    else if (this.textContents.substr(1, 1) === Message.MANAGEMENT_MESSAGE_TYPES.CONTACT) {
        var nodes = JSON.parse(this.textContents.substr(2, this.textContents.length));
        if (nodes.length === 1) {
            return __("Sent Contact: %s").replace("%s", nodes[0].name);
        }
        else {
            return __("Sent %s Contacts.").replace("%s", nodes.length);
        }
    }
    else if (this.textContents.substr(1, 1) === Message.MANAGEMENT_MESSAGE_TYPES.REVOKE_ATTACHMENT) {
        return __("Revoked access to attachment(s).");
    }
};

/**
 * Simple interface/structure wrapper for inline dialogs
 * @param opts
 * @constructor
 */
var ChatDialogMessage = function(opts) {
    assert(opts.messageId, 'missing messageId');
    assert(opts.type, 'missing type');

    MegaDataObject.attachToExistingJSObject(
        this,
        {
            'type': true,
            'messageId': true,
            'textContents': true,
            'authorContact': true,
            'delay': true,
            'buttons': true,
            'read': true,
            'protocol': false,
            'persist': true,
            'deleted': 0,
            'seen': false
        },
        true,
        ChatDialogMessage.DEFAULT_OPTS
    );
    $.extend(true, this, opts);

    return this;
};

/**
 * Default values for the ChatDialogMessage interface/datastruct.
 *
 * @type {Object}
 */
ChatDialogMessage.DEFAULT_OPTS = {
    'type': '',
    'messageId': '',
    'textContents': '',
    'authorContact': '',
    'delay': 0,
    'buttons': {},
    'read': false,
    'persist': true
};


/**
 * Basic collection class that should collect all messages from different sources (chatd at the moment and xmpp in the
 * future)
 *
 * @param chatRoom
 * @param chatdInt
 * @constructor
 */
var MessagesBuff = function(chatRoom, chatdInt) {
    var self = this;

    self.chatRoom = chatRoom;
    self.chatdInt = chatdInt;
    self.chatd = chatdInt.chatd;

    self.messages = new MegaDataSortedMap("messageId", "orderValue,delay", this);

    self.lastSeen = null;
    self.lastSent = null;
    self.lastDelivered = null;
    self.isRetrievingHistory = false;
    self.lastDeliveredMessageRetrieved = false;
    self.lastSeenMessageRetrieved = false;
    self.retrievedAllMessages = false;

    self.chatdIsProcessingHistory = false;
    self._currentHistoryPointer = 0;
    self.$msgsHistoryLoading = null;
    self._unreadCountCache = 0;

    self.haveMessages = false;
    self.joined = false;

    self.logger = MegaLogger.getLogger("messagesBuff[" + chatRoom.roomJid.split("@")[0] + "]", {}, chatRoom.logger);

    manualTrackChangesOnStructure(self, true);

    self._parent = chatRoom;

    var chatRoomId = chatRoom.roomJid.split("@")[0];

    self.chatd.rebind('onMessageLastSeen.messagesBuff' + chatRoomId, function(e, eventData) {
        var chatRoom = self.chatdInt._getChatRoomFromEventData(eventData);

        if (!chatRoom) {
            self.logger.warn("Message not found for: ", e, eventData);
            return;
        }

        if (chatRoom.roomJid === self.chatRoom.roomJid) {
            self.lastSeen = eventData.messageId;
            self.trackDataChange();
        }
    });
    self.chatd.rebind('onMembersUpdated.messagesBuff' + chatRoomId, function(e, eventData) {
        var chatRoom = self.chatdInt._getChatRoomFromEventData(eventData);

        if (!chatRoom) {
            self.logger.warn("Message not found for: ", e, eventData);
            return;
        }

        if (chatRoom.roomJid === self.chatRoom.roomJid) {
            if (eventData.userId === u_handle) {
                self.joined = true;
                if (chatRoom.state === ChatRoom.STATE.JOINING) {
                    chatRoom.setState(ChatRoom.STATE.READY);
                }
            }
        }
    });

    self.chatd.rebind('onMessageConfirm.messagesBuff' + chatRoomId, function(e, eventData) {
        var chatRoom = self.chatdInt._getChatRoomFromEventData(eventData);

        if (chatRoom.roomJid === self.chatRoom.roomJid) {
            self.lastSent = eventData.messageId;
            self.trackDataChange();
        }
    });

    self.chatd.rebind('onMessageLastReceived.messagesBuff' + chatRoomId, function(e, eventData) {
        var chatRoom = self.chatdInt._getChatRoomFromEventData(eventData);

        if (chatRoom.roomJid === self.chatRoom.roomJid) {
            self.setLastReceived(eventData.messageId);
        }
    });

    self.chatd.rebind('onMessagesHistoryDone.messagesBuff' + chatRoomId, function(e, eventData) {
        var chatRoom = self.chatdInt._getChatRoomFromEventData(eventData);

        if (chatRoom.roomJid === self.chatRoom.roomJid) {
            self.isRetrievingHistory = false;
            self.chatdIsProcessingHistory = false;
            self.haveMessages = true;

            if (self.$msgsHistoryLoading && self.$msgsHistoryLoading.state() === 'pending') {
                self.$msgsHistoryLoading.resolve();
            }

            if (self.expectedMessagesCount > 0) {
                self.retrievedAllMessages = true;
            }
            delete self.expectedMessagesCount;

            $(self).trigger('onHistoryFinished');

            self.trackDataChange();
        }
    });


    self.chatd.rebind('onMessagesHistoryRequest.messagesBuff' + chatRoomId, function(e, eventData) {
        var chatRoom = self.chatdInt._getChatRoomFromEventData(eventData);

        if (chatRoom.roomJid === self.chatRoom.roomJid) {
            self.isRetrievingHistory = true;
            self.expectedMessagesCount = eventData.count * -1;
            self.trackDataChange();
        }
    });

    self.chatd.rebind('onMessagesHistoryRetrieve.messagesBuff' + chatRoomId, function(e, eventData) {
        var chatRoom = self.chatdInt._getChatRoomFromEventData(eventData);

        if (!chatRoom) {
            self.logger.warn("Message not found for: ", e, eventData);
            return;
        }
        if (chatRoom.roomJid === self.chatRoom.roomJid) {
            self.haveMessages = true;
            self.trackDataChange();
            self.retrieveChatHistory(true);
        }
    });

    self.chatd.rebind('onMessageStore.messagesBuff' + chatRoomId, function(e, eventData) {
        var chatRoom = self.chatdInt._getChatRoomFromEventData(eventData);

        if (chatRoom.roomJid === self.chatRoom.roomJid) {
            self.haveMessages = true;

            var msgObject = new Message(chatRoom,
                self,
                {
                    'messageId': eventData.messageId,
                    'userId': eventData.userId,
                    'keyid': eventData.keyid,
                    'message': eventData.message,
                    'delay': eventData.ts,
                    'orderValue': eventData.id,
                    'updated': eventData.updated
                }
            );

            if (eventData.messageId === self.lastSeen) {
                self.lastSeenMessageRetrieved = true;
            }
            if (eventData.messageId === self.lastDelivered) {
                self.lastDeliveredMessageRetrieved = true;
            }

            // is my own message?
            // mark as sent, since the msg was echoed from the server
            if (eventData.userId === u_handle) {
                msgObject.sent = Message.STATE.SENT;
            }
            var cacheKey = chatRoom.chatId + "_" + eventData.messageId;
            // if the message has already been decrypted, then just bail.
            if (self.chatRoom.megaChat.plugins.chatdIntegration._processedMessages[cacheKey]) {
                return;
            }
            self.messages.push(msgObject);

            if (!eventData.isNew) {
                self.expectedMessagesCount--;
                if (eventData.userId !== u_handle) {
                    if (self.lastDeliveredMessageRetrieved === true) {
                        // received a message from history, which was NOT marked as received, e.g. was sent during
                        // this user was offline, so -> do proceed and mark it as received automatically
                        self.setLastReceived(eventData.messageId);

                    }
                }
            }
            else {
                // if not from history
                // mark as received if not sent by me
                if (eventData.userId !== u_handle) {
                    self.setLastReceived(eventData.messageId);
                }
                $(self).trigger('onNewMessageReceived', msgObject);
            }
        }
    });

    self.chatd.rebind('onMessageCheck.messagesBuff' + chatRoomId, function(e, eventData) {
        var chatRoom = self.chatdInt._getChatRoomFromEventData(eventData);

        if (!chatRoom) {
            self.logger.warn("Message not found for: ", e, eventData);
            return;
        }

        if (chatRoom.roomJid === self.chatRoom.roomJid) {
            self.haveMessages = true;

            if (!self.messages[eventData.messageId]) {
                self.retrieveChatHistory(true);
            }
        }
    });

    self.chatd.rebind('onMessageUpdated.messagesBuff' + chatRoomId, function(e, eventData) {
        var chatRoom = self.chatdInt._getChatRoomFromEventData(eventData);

        if (self.chatRoom.chatId !== chatRoom.chatId) {
            return; // ignore event
        }
        console.error(eventData.id, eventData.state, eventData);

        if (eventData.state === "EDITED" || eventData.state === "TRUNCATED" /*|| eventData.state === "EXPIRED"*/) {
            var timestamp = (
                eventData.state === "EDITED" ? chatRoom.messagesBuff.messages[eventData.messageId].delay : unixtime()
            );

            var editedMessage = new Message(
                chatRoom,
                self,
                {
                    'messageId': eventData.messageId,
                    'userId': eventData.userId,
                    'keyid': eventData.keyid,
                    'message': eventData.message,
                    'updated': eventData.updated,
                    'delay' : timestamp,
                    'orderValue': eventData.id,
                    'sent': true
                }
            );

            var _runDecryption = function() {
                try
                {
                    var decrypted = chatRoom.protocolHandler.decryptFrom(
                        eventData.message,
                        eventData.userId,
                        eventData.keyid,
                        false
                    );
                    if (decrypted) {

                        //if the edited payload is an empty string, it means the message has been deleted.
                        editedMessage.textContents = decrypted.payload;
                        if (decrypted.type === strongvelope.MESSAGE_TYPES.TRUNCATE) {
                            editedMessage.dialogType = 'truncated';
                            editedMessage.userId = decrypted.sender;
                        }
                        chatRoom.messagesBuff.messages.removeByKey(eventData.messageId);
                        chatRoom.messagesBuff.messages.push(editedMessage);

                        chatRoom.megaChat.plugins.chatdIntegration._parseMessage(
                            chatRoom, chatRoom.messagesBuff.messages[eventData.messageId]
                        );


                        if (decrypted.type === strongvelope.MESSAGE_TYPES.TRUNCATE) {
                            var messageKeys = chatRoom.messagesBuff.messages.keys();

                            for (var i = 0; i < messageKeys.length; i++) {
                                var v = chatRoom.messagesBuff.messages[messageKeys[i]];

                                if (v.orderValue < eventData.id) {
                                    // remove the messages with orderValue < eventData.id from message buffer.
                                    chatRoom.messagesBuff.messages.removeByKey(v.messageId);
                                }
                            }
                        }


                    }
                } catch(e) {
                    self.logger.error("Failed to decrypt stuff via strongvelope, because of uncaught exception: ", e);
                }
            };

            var promises = [];
            promises.push(
                ChatdIntegration._ensureKeysAreLoaded([editedMessage])
            );

            MegaPromise.allDone(promises).always(function() {
                _runDecryption();
            });
        }
        else if (eventData.state === "CONFIRMED") {
            self.haveMessages = true;

            if (!eventData.id) {
                debugger;
            }

            var foundMessage = self.getByInternalId(eventData.id);

            if (foundMessage) {
                var confirmedMessage = new Message(
                    chatRoom,
                    self,
                    {
                        'messageId': eventData.messageId,
                        'userId': eventData.userId,
                        'keyid': eventData.keyid,
                        'message': eventData.message,
                        'textContents': foundMessage.textContents ? foundMessage.textContents : "",
                        'delay': foundMessage.delay,
                        'orderValue': eventData.id,
                        'sent': true
                    }
                );

                self.messages.removeByKey(foundMessage.messageId);
                self.messages.push(confirmedMessage);

                if (foundMessage.textContents) {
                    self.chatRoom.megaChat.plugins.chatdIntegration._parseMessage(chatRoom, confirmedMessage);
                }
            }
            else {
                // its ok, this happens when a system/protocol message was sent OR this message was re-sent by chatd
                // after the page had been reloaded
                self.logger.warn("Not found: ", eventData.id);
                return;
            }
        }
        else if (eventData.state === "DISCARDED") {
            // messages was already sent, but the confirmation was not received, so this is a dup and should be removed
            self.haveMessages = true;

            if (!eventData.id) {
                debugger;
            }

            var foundMessage = self.getByInternalId(eventData.id);

            if (foundMessage) {
                self.messages.removeByKey(foundMessage.messageId);
            }
            else {
                // its ok, this happens when a system/protocol message was sent
                console.error("Not found: ", eventData.id);
                return;
            }
        }
        else if (eventData.state === "EXPIRED") {
            self.haveMessages = true;

            if (!eventData.id) {
                debugger;
            }

            var foundMessage = self.getByInternalId(eventData.id);

            if (foundMessage) {
                foundMessage.sent = Message.STATE.NOT_SENT_EXPIRED;
                foundMessage.requiresManualRetry = true;
            }
            else {
                // its ok, this happens when a system/protocol message was sent
                console.error("Not found: ", eventData.id);
                return;
            }
        }
        else if (eventData.state === "RESTOREDEXPIRED") {
            self.haveMessages = true;

            if (!eventData.id) {
                debugger;
            }

            // x = {
            //     "chatId": "5oH6FNO5bLA",
            //     "userId": "cypQ7i9inlY",
            //     "id": 536870913,
            //     "state": "RESTOREDEXPIRED",
            //     "keyid": 80,
            //     "message": "\u0002\u0001\u0001\u0000@×O³ªn\u0006\t\\¥WZ8}Þ³Ñ0!²KYf\u0006õ6ÜôÁ¬cÉ2båÑb¥\u0003v-¹¶ÙUCå°b·Ù-¡\u000f\u0003\u0000\f\u001e\u001a\u0010{\u000fÙ?V8U00\u0007\u0000\u0005Hô\b¸",
            //     "ts": 1464103120
            // };

            var foundMessage = self.getByInternalId(eventData.id);

            if (foundMessage) {
                self.removeMessageById(foundMessage.messageId);
            }
            
            var outgoingMessage = new KarereEventObjects.OutgoingMessage(
                    chatRoom.megaChat.getJidFromNodeId(eventData.userId),
                    chatRoom.megaChat.karere.getJid(),
                    "groupchat",
                    "mexp" + eventData.id,
                    "",
                    {},
                    eventData.ts,
                    Message.STATE.NOT_SENT_EXPIRED,
                    chatRoom.roomJid
                );
            outgoingMessage.internalId = eventData.id;
            outgoingMessage.orderValue = eventData.id;
            outgoingMessage.requiresManualRetry = true;
            outgoingMessage.userId = eventData.userId;

            var _runDecryption = function() {
                try
                {
                    var decrypted = chatRoom.protocolHandler.decryptFrom(
                        eventData.message,
                        eventData.userId,
                        eventData.keyid,
                        false
                    );
                    if (decrypted) {

                        //if the edited payload is an empty string, it means the message has been deleted.
                        outgoingMessage.contents = decrypted.payload;
                        chatRoom.messagesBuff.messages.removeByKey(eventData.messageId);
                        chatRoom.messagesBuff.messages.push(outgoingMessage);

                        chatRoom.megaChat.plugins.chatdIntegration._parseMessage(
                            chatRoom, chatRoom.messagesBuff.messages[eventData.messageId]
                        );

                    }
                } catch(e) {
                    self.logger.error("Failed to decrypt stuff via strongvelope, because of uncaught exception: ", e);
                }
            };

            var promises = [];
            promises.push(
                ChatdIntegration._ensureKeysAreLoaded([outgoingMessage])
            );

            MegaPromise.allDone(promises).always(function() {
                _runDecryption();
            });
        }

        // pending would be handled automatically, because all NEW messages are set with state === NOT_SENT (== PENDING)
    });

    self.chatd.rebind('onMessagesKeyIdDone.messagesBuff' + chatRoomId, function(e, eventData) {
        var chatRoom = self.chatdInt._getChatRoomFromEventData(eventData);
        chatRoom.protocolHandler.setKeyID(eventData.keyxid, eventData.keyid);

        if (chatRoom.roomJid === self.chatRoom.roomJid) {
            self.trackDataChange();
        }
    });

    self.chatd.rebind('onMessageKeysDone.messagesBuff' + chatRoomId, function(e, eventData) {
        var chatRoom = self.chatdInt._getChatRoomFromEventData(eventData);
        var keys = eventData.keys;
        var seedKeys = function() {
            chatRoom.protocolHandler.seedKeys(keys);
        };
        ChatdIntegration._ensureKeysAreLoaded(keys).always(seedKeys);

        if (chatRoom.roomJid === self.chatRoom.roomJid) {
            self.trackDataChange();
        }
    });

    self.chatd.rebind('onMessageKeyRestore.messagesBuff' + chatRoomId, function(e, eventData) {
        var chatRoom = self.chatdInt._getChatRoomFromEventData(eventData);
        var keyxid = eventData.keyid;
        var keys = eventData.keys;
        console.log('onMessageKeyRestore');
        console.log(chatRoom);
        var seedKeys = function() {
            chatRoom.protocolHandler.restoreKeys(keyxid, keys);
        };
        ChatdIntegration._ensureKeysAreLoaded(keys).always(seedKeys);

        if (chatRoom.roomJid === self.chatRoom.roomJid) {
            self.trackDataChange();
        }
    });

    self.addChangeListener(function() {
        var newCounter = 0;
        self.messages.forEach(function(v, k) {
            if (v.getState && v.getState() === Message.STATE.NOT_SEEN) {
                var shouldRender = true;
                if (v.isManagement && v.isManagement() === true && v.isRenderableManagement() === false) {
                    shouldRender = false;
                }

                if (shouldRender) {
                    newCounter++;
                }
            }
        });
        if (self._unreadCountCache !== newCounter) {
            self._unreadCountCache = newCounter;
            self.chatRoom.megaChat.updateSectionUnreadCount();
        }
    });
};


MessagesBuff.prototype.getByInternalId = function(internalId) {
    assert(internalId, 'missing internalId');

    var self = this;
    var found = false;

    self.messages.every(function(v, k) {
        if (v.internalId === internalId) {

            found = v;

            return false; // break
        }
        else {
            return true;
        }
    });
    return found;
};
MessagesBuff.prototype.getUnreadCount = function() {
    return this._unreadCountCache;
};

MessagesBuff.prototype.setLastSeen = function(msgId) {
    var self = this;
    var targetMsg = Message._mockupNonLoadedMessage(msgId, self.messages[msgId], 999999999);
    var lastMsg = Message._mockupNonLoadedMessage(self.lastSeen, self.messages[self.lastSeen], 0);

    if (!self.lastSeen || lastMsg.orderValue < targetMsg.orderValue) {
        self.lastSeen = msgId;

        if (!self.isRetrievingHistory) {
            self.chatdInt.markMessageAsSeen(self.chatRoom, msgId);
        }

        // check if last recv needs to be updated
        var lastRecvMessage = self.messages[self.lastDelivered];
        if (self.lastDelivered && !lastRecvMessage) {
            lastRecvMessage = {
                'messageId': self.lastDelivered,
                'orderValue': 0 /* from history! */
            };
        }

        if (!lastRecvMessage || lastRecvMessage.orderValue < targetMsg.orderValue) {
            self.setLastReceived(msgId);
        }

        self.trackDataChange();
    }
};


MessagesBuff.prototype.setLastReceived = function(msgId) {
    var self = this;
    var targetMsg = Message._mockupNonLoadedMessage(msgId, self.messages[msgId], 0);
    var lastMsg = Message._mockupNonLoadedMessage(self.lastDelivered, self.messages[self.lastDelivered], 999999999);

    if (!self.lastDelivered || lastMsg.orderValue < targetMsg.orderValue) {

        self.lastDelivered = msgId;
        if (!self.isRetrievingHistory) {
            if (targetMsg.userId !== u_handle) {
                self.chatdInt.markMessageAsReceived(self.chatRoom, msgId);
            } else {
                // dont do anything.
            }
        }

        self.trackDataChange();
    }
    else {
        // its totally normal if this branch of code is executed, just don't do nothing
    }
};


MessagesBuff.prototype.messagesHistoryIsLoading = function() {
    var self = this;
    return (
            self.$msgsHistoryLoading && self.$msgsHistoryLoading.state() === 'pending'
        ) || self.chatdIsProcessingHistory;
};

MessagesBuff.prototype.retrieveChatHistory = function(isInitialRetrivalCall) {
    var self = this;

    if (self.messagesHistoryIsLoading()) {
        return self.$msgsHistoryLoading;
    }
    else {
        self.chatdIsProcessingHistory = true;
        if (!isInitialRetrivalCall) {
            self._currentHistoryPointer -= 32;
        }

        self.$msgsHistoryLoading = new MegaPromise();
        self.chatdInt.retrieveHistory(
            self.chatRoom,
            -32
        );

        self.trackDataChange();


        var timeoutPromise = createTimeoutPromise(function() {
            return self.$msgsHistoryLoading.state() !== 'pending'
        }, 100, 10000)
            .always(function() {
                self.chatdIsProcessingHistory = false;
            })
            .fail(function() {
                self.$msgsHistoryLoading.reject();
            })
            .always(function() {
                self.trackDataChange();
            });

        self.$msgsHistoryLoading.fail(function() {
            console.error("HIST FAILED: ", arguments);
            if (!isInitialRetrivalCall) {
                self._currentHistoryPointer += 32;
            }
        });


        return self.$msgsHistoryLoading;
    }
};

MessagesBuff.prototype.haveMoreHistory = function() {
    var self = this;

    if (!self.haveMessages) {
        return false;
    }
    else if (self.retrievedAllMessages === false) {
        return true;
    }
    else {
        return false;
    }
};


MessagesBuff.prototype.markAllAsSeen = function() {
    var self = this;
    var lastToBeMarkedAsSeen = null;

    var keys = clone(self.messages.keys());
    keys.forEach(function(k) {
        var msg = self.messages[k];

        if (msg.userId !== u_handle) {
            lastToBeMarkedAsSeen = k;
            return false; // break?
        }
    });

    if (lastToBeMarkedAsSeen) {
        self.setLastSeen(lastToBeMarkedAsSeen);
    }
};
MessagesBuff.prototype.markAllAsReceived = function() {
    var self = this;

    var lastToBeMarkedAsReceived = null;

    // TODO: move to .getItem(-1).messageId ?
    var keys = clone(self.messages.keys());
    keys.forEach(function(k) {
        var msg = self.messages[k];

        lastToBeMarkedAsReceived = k;
    });

    if (lastToBeMarkedAsReceived) {
        self.setLastReceived(lastToBeMarkedAsReceived);
    }
};


/**
 * Get message by Id
 * @param messageId {string} message id
 * @returns {boolean}
 */
MessagesBuff.prototype.getMessageById = function(messageId) {
    var self = this;
    var found = false;
    $.each(self.messages, function(k, v) {
        if (v.messageId === messageId) {
            found = v;
            return false; //break;
        }
    });

    return found;
};

MessagesBuff.prototype.removeMessageById = function(messageId) {
    var self = this;
    self.messages.forEach(function(v, k) {
        if (v.deleted === 1) {
            return; // skip
        }

        if (v.messageId === messageId) {
            v.deleted = 1;
            if (!v.seen) {
                v.seen = true;
            }

            // cleanup the messagesIndex
            self.messages.removeByKey(v.messageId);
            return false; // break;
        }
    });
};
MessagesBuff.prototype.removeMessageBy = function(cb) {
    var self = this;
    self.messages.forEach(function(v, k) {
        if (cb(v, k) === true) {
            self.removeMessageById(v.messageId);
        }
    });
};
MessagesBuff.prototype.removeMessageByType = function(type) {
    var self = this;
    self.removeMessageBy(function(v, k) {
        if (v.type === type) {
            return true;
        }
        else {
            return false;
        }
    })
};

MessagesBuff.prototype.getLatestTextMessage = function() {
    if (this.messages.length > 0) {
        var msgs = this.messages;
        for(var i = msgs.length - 1; i >= 0; i--) {
            if (msgs.getItem(i) && msgs.getItem(i).textContents && msgs.getItem(i).textContents.length > 0) {
                var msg = msgs.getItem(i);
                if (msg.isManagement && msg.isManagement() === true && msg.isRenderableManagement() === false) {
                    continue;
                }
                return msg;
            }
        }
        // no renderable msgs found
        return false;
    }
    else {
        return false;
    }
};
