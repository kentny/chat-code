import { toastController } from '@ionic/core';
import type { ChatCompletionRequestMessage, CreateCompletionResponseUsage } from 'openai';
import { assign, createMachine, interpret } from 'xstate';
import {
	chatList,
	chatListStoreId,
	type ChatCompletionRequestMessageWithTimeStamp,
	type ChatListType
} from '~/store/chatList';
import { store } from '~/store/store';

export type Context = {
	id?: string;
	model: string;
	apiKey?: string;
	messages: ChatCompletionRequestMessageWithTimeStamp[];
	usages: CreateCompletionResponseUsage[];
	streamMessage?: string;
	conversationMode: boolean;
	temperature: number;
	topP: number;
};

type Events =
	| { type: 'INIT' }
	| { type: 'READY' }
	| { type: 'SET_API_TOKEN'; apiKey: string }
	| { type: 'SET_ID'; id: string }
	| { type: 'SET_MODEL'; model: string }
	| { type: 'SET_TEMPERATURE'; temperature: number }
	| { type: 'SET_TOP_P'; topP: number }
	| { type: 'SET_CONVERSATION_MODE'; conversationMode: boolean }
	| { type: 'RESET' }
	| { type: 'ADD_MESSAGES'; messages: ChatCompletionRequestMessage[] }
	| { type: 'ADD_USAGES'; usages: CreateCompletionResponseUsage[] }
	| { type: 'SET_USAGES'; usages: CreateCompletionResponseUsage[] }
	| { type: 'ADD_STREAM_MESSAGE'; streamMessage: string }
	| { type: 'RESET_STREAM_MESSAGE' };

type StreamJson = {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: [
		{
			delta: { content: string };
			index: number;
			finish_reason: 'stop' | null;
		}
	];
};

export const chatMachine = createMachine(
	{
		schema: {
			context: {} as Context,
			events: {} as Events
		},
		id: 'chat',
		context: {
			model: 'gpt-3.5-turbo',
			messages: [],
			usages: [],
			conversationMode: true,
			temperature: 1,
			topP: 1
		},
		initial: 'idle',
		on: {
			SET_ID: { actions: 'setId', target: 'initializing' },
			SET_API_TOKEN: { actions: 'setApiKey' },
			SET_CONVERSATION_MODE: { actions: 'setConversationMode' },
			SET_MODEL: { actions: 'setModel' },
			SET_TEMPERATURE: { actions: 'setTemperature' },
			SET_TOP_P: { actions: 'setTopP' }
		},
		states: {
			idle: {
				on: {
					SET_ID: { actions: 'setId' },
					INIT: 'initializing'
				}
			},
			initializing: {
				invoke: {
					src:
						({ id }) =>
						(callback) => {
							(async () => {
								const cList = (await store.get<ChatListType>(chatListStoreId)) ?? [];
								const chat = cList.find((item) => item.id === id);
								callback('RESET');
								if (chat) {
									const { messages, usages } = chat.content;
									callback({ type: 'ADD_MESSAGES', messages });
									callback({ type: 'ADD_USAGES', usages });
								} else if (id) {
									chatList.add({
										id,
										content: { messages: [], usages: [] }
									});
								}
								callback('INIT');
							})();
						}
				},
				on: {
					ADD_MESSAGES: { actions: 'addMessages' },
					ADD_USAGES: { actions: 'addUsages' },
					INIT: 'ready',
					RESET: { actions: 'reset' }
				}
			},
			ready: {
				on: {
					ADD_MESSAGES: {
						actions: 'addMessages',
						target: 'chatting'
					}
				}
			},
			chatting: {
				exit: ['resetStreamMessage'],
				invoke: {
					src:
						({ model, messages: contextMessages, apiKey, conversationMode, temperature, topP }) =>
						(callback) => {
							if (!apiKey) {
								throw new Error('OpenAI not initialized');
							}

							(async () => {
								// eslint-disable-next-line @typescript-eslint/no-unused-vars
								const messages = contextMessages.map(({ timestamp, ...message }) => message);
								const completion = await fetch('https://api.openai.com/v1/chat/completions', {
									headers: {
										'Content-Type': 'application/json',
										Authorization: `Bearer ${apiKey}`
									},
									method: 'POST',
									body: JSON.stringify({
										messages: conversationMode ? messages : messages.slice(-1),
										model: model,
										stream: true,
										temperature: temperature ?? 1,
										top_p: topP ?? 1
									})
								});

								const reader = completion.body?.getReader();

								if (completion.status !== 200 || !reader) {
									toastController
										.create({
											message: `${completion.status}: Error connecting to OpenAI.`,
											duration: 20000,
											color: 'danger'
										})
										.then((toast) => {
											toast.onclick = () => toast.dismiss();
											toast.present();
										});
									callback('READY');
									return;
								}

								const decoder = new TextDecoder('utf-8');
								try {
									const read = async (): Promise<any> => {
										const { done, value } = await reader.read();
										if (done) return reader.releaseLock();

										const chunk = decoder.decode(value, { stream: true });
										const json: StreamJson[] = chunk
											.split('data:')
											.map((data) => {
												const trimData = data.trim();
												if (trimData === '') return undefined;
												if (trimData === '[DONE]') return undefined;
												return JSON.parse(data.trim());
											})
											.filter((data) => data);

										const streamMessage = json
											.map((jn) => jn.choices.map((choice) => choice.delta.content).join(''))
											.join('');
										callback({ type: 'ADD_STREAM_MESSAGE', streamMessage });

										return read();
									};
									await read();
								} catch (e) {
									console.error(e);
								}

								reader.releaseLock();
								callback('READY');
							})();
						}
				},
				on: {
					READY: 'ready',
					SET_USAGES: { actions: 'setUsages' },
					ADD_STREAM_MESSAGE: { actions: 'addStreamMessage' }
				}
			}
		}
	},
	{
		actions: {
			setApiKey: assign({
				apiKey: (_, event) => ('apiKey' in event ? event.apiKey : undefined)
			}),
			setId: assign({
				id: (_, event) => ('id' in event ? event.id : undefined)
			}),
			setConversationMode: assign({
				conversationMode: (_, event) =>
					'conversationMode' in event ? event.conversationMode : true
			}),
			setModel: assign({
				model: (_, event) => ('model' in event ? event.model : 'gpt-3.5-turbo')
			}),
			setTemperature: assign({
				temperature: (_, event) => ('temperature' in event ? event.temperature : 1)
			}),
			setTopP: assign({
				topP: (_, event) => ('topP' in event ? event.topP : 1)
			}),
			addMessages: assign({
				messages: ({ id, messages }, event) => {
					if (!('messages' in event) || !id) return messages;
					const results = [
						...messages,
						...event.messages.map((message) => ({ timestamp: Date.now(), ...message }))
					];
					chatList.updateMessages(id, results);
					return results;
				}
			}),
			addUsages: assign({
				usages: ({ id, usages }, event) => {
					if (!('usages' in event) || !id) return usages;
					const results = [...usages, ...event.usages];
					chatList.updateUsages(id, results);
					return results;
				}
			}),
			setUsages: assign({
				usages: ({ id, usages }, event) => {
					if (!('usages' in event) || !id) return usages;
					const results = event.usages;
					chatList.updateUsages(id, results);
					return results;
				}
			}),
			addStreamMessage: assign({
				streamMessage: ({ streamMessage }, event) => {
					if (!('streamMessage' in event)) return;
					if (!streamMessage) return event.streamMessage;
					return streamMessage + event.streamMessage;
				}
			}),
			resetStreamMessage: assign({
				streamMessage: () => undefined,
				messages: ({ id, messages, streamMessage }) => {
					if (!streamMessage || !id) return messages;
					const results = [
						...messages,
						{
							role: 'assistant',
							content: streamMessage,
							timestamp: Date.now()
						} as ChatCompletionRequestMessage
					];
					chatList.updateMessages(id, results);
					return results;
				},
				usages: ({ id, usages, messages, streamMessage, conversationMode }) => {
					if (!streamMessage || !id) return usages;
					const tokens = Math.floor(
						(conversationMode ? messages : messages.slice(-2))
							.map((message) => message.content.length)
							.reduce((a, b) => a + b, streamMessage.length) * 0.75
					);
					const results = [
						...usages,
						{
							prompt_tokens: tokens,
							completion_tokens: tokens,
							total_tokens: tokens
						}
					];
					chatList.updateUsages(id, results);
					return results;
				}
			}),
			reset: assign({
				usages: () => [],
				messages: () => []
			})
		}
	}
);

export const chatService = interpret(chatMachine).start();
