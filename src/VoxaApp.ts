import * as _ from 'lodash';
import * as debug from 'debug';
import * as i18n from 'i18next';
import * as bluebird from 'bluebird';

import { VoxaReply, IReply } from './VoxaReply';
import { UnknownRequestType, OnSessionEndedError } from './Errors';
import { StateMachine, Transition, StateMachineConfig, State } from './StateMachine';
import { Renderer, IMessage, IRenderer, IRendererConfig } from './renderers/Renderer';
import { IVoxaEvent } from './VoxaEvent';
import { IModel, Model } from './Model';

const log:debug.IDebugger = debug('voxa');

export interface VoxaAppConfig extends IRendererConfig{
  appIds?: string[]|string;
  Model: IModel;
  RenderClass: IRenderer;
  views: any;
  variables: any;
}

export class VoxaApp {
  [x: string]: any;
  public eventHandlers: any;
  public requestHandlers: any;

  public config: VoxaAppConfig;
  public renderer: Renderer;
  public i18nextPromise: PromiseLike<i18n.TranslationFunction>;
  public states: any;

  constructor(config: VoxaAppConfig) {
    this.config = config;
    this.eventHandlers = {};
    this.requestHandlers = {
      SessionEndedRequest: this.handleOnSessionEnded.bind(this),
    };

    _.forEach(this.requestTypes, requestType => this.registerRequestHandler(requestType));
    this.registerEvents();
    this.onError((voxaEvent: IVoxaEvent, error: Error, ReplyClass: IReply<VoxaReply>): VoxaReply => {
      log('onError %s', error);
      log(error.stack);
      const reply =  new ReplyClass(voxaEvent, this.renderer);
      reply.response.statements.push('An unrecoverable error occurred.');
      return reply;
    }, true);

    this.states = {};
    this.config = _.assign({
      RenderClass: Renderer,
      Model,
    }, this.config);

    this.validateConfig();

    this.i18nextPromise = new Promise((resolve, reject) => {
      i18n.init({
        resources: this.config.views,
        load: 'all',
        nonExplicitWhitelist: true,
      }, (err: Error, t: i18n.TranslationFunction) => {
        if(err) return reject(err);
        return resolve(t);
      })
    });

    this.renderer = new this.config.RenderClass(this.config);

    // this can be used to plug new information in the request
    // default is to just initialize the model
    this.onRequestStarted(this.transformRequest);

    // run the state machine for intentRequests
    this.onIntentRequest(this.runStateMachine, true);

    this.onAfterStateChanged(async (voxaEvent: IVoxaEvent, reply: VoxaReply, transition: Transition) : Promise<Transition> => {
      const result = await Promise.all(_.map((transition), async (value: any, key: string) => {
        const directiveHandler = _.find(reply.directiveHandlers, { key })
        if (!directiveHandler) {
          return;
        }

        return await directiveHandler.handler(value)(reply, voxaEvent);
      }));

      return await transition;
    });

    this.onBeforeReplySent(async (voxaEvent: IVoxaEvent, reply: VoxaReply, transition: Transition): Promise<void> => {
      const serialize = _.get(voxaEvent, 'model.serialize');

      // we do require models to have a serialize method and check that when Voxa is initialized,
      // however, developers could do stuff like `voxaEvent.model = null`,
      // which seems natural if they want to
      // clear the model
      if (!serialize) {
        voxaEvent.model = new this.config.Model();
      }

      if (typeof transition.to === 'string') {
        voxaEvent.model._state = transition.to;
      } else {
        voxaEvent.model._state = transition.to.name;
      }

      const modelData = await voxaEvent.model.serialize();
      voxaEvent.session.attributes.model = modelData;
    });
  }

  validateConfig() {
    if (!this.config.Model.fromEvent) {
      throw new Error('Model should have a fromEvent method');
    }

    if (!this.config.Model.serialize && !(this.config.Model.prototype && this.config.Model.prototype.serialize)) {
      throw new Error('Model should have a serialize method');
    }
  }

  /*
   * This way we can simply override the method if we want different request types
   */
  get requestTypes(): Array<string> { // eslint-disable-line class-methods-use-this
    return [
      'IntentRequest',
      'SessionEndedRequest',
    ];
  }

  async handleOnSessionEnded(voxaEvent: IVoxaEvent, reply: VoxaReply) : Promise<VoxaReply> {
    console.log('handleOnSessionEnded')
    console.log(this.getOnSessionEndedHandlers())
    const replies = await bluebird.mapSeries(this.getOnSessionEndedHandlers(), (fn: Function) => fn(voxaEvent, reply))
    if (replies.length) {
      return _.last(replies);
    }

    return reply;
  }

  /*
   * iterate on all error handlers and simply return the first one that
   * generates a reply
   */
  async handleErrors(event: IVoxaEvent, error: Error, ReplyClass: IReply<VoxaReply>): Promise<VoxaReply> {
    const reply: VoxaReply = await bluebird.reduce(this.getOnErrorHandlers(), (reply: VoxaReply, errorHandler: Function) => {
      if (reply) {
        return reply;
      }
      return Promise.resolve(errorHandler(event, error, ReplyClass));
    }, null)

    reply.error = error;
    return reply;
  }


  async execute(voxaEvent: IVoxaEvent, ReplyClass: IReply<VoxaReply>): Promise<any> {
    log('Received new event');
    log(voxaEvent);
    try {
      const voxaReply = new ReplyClass(voxaEvent, this.renderer);
      // Validate that this AlexaRequest originated from authorized source.
      if (this.config.appIds) {
        const appId = voxaEvent.context.application.applicationId;

        if (_.isString(this.config.appIds) && this.config.appIds !== appId) {
          log(`The applicationIds don't match: "${voxaEvent.context.application.applicationId}"  and  "${this.config.appIds}"`);
          throw new Error('Invalid applicationId');
        }

        if (_.isArray(this.config.appIds) && !_.includes(this.config.appIds, appId)) {
          log(`The applicationIds don't match: "${voxaEvent.context.application.applicationId}"  and  "${this.config.appIds}"`);
          throw new Error('Invalid applicationId');
        }
      }

      if (!this.requestHandlers[voxaEvent.request.type]) {
        throw new UnknownRequestType(voxaEvent.request.type);
      }

      const requestHandler = this.requestHandlers[voxaEvent.request.type];

      switch (voxaEvent.request.type) {
        case 'IntentRequest':
        case 'SessionEndedRequest': {
          // call all onRequestStarted callbacks serially.
          const result = await bluebird.mapSeries(this.getOnRequestStartedHandlers(), (fn: Function): void => fn(voxaEvent, voxaReply))
          if (voxaEvent.request.type === 'SessionEndedRequest' && _.get(voxaEvent, 'request.reason') === 'ERROR') {
            throw new OnSessionEndedError(_.get(voxaEvent, 'request.error'));
          }

          // call all onSessionStarted callbacks serially.
          await bluebird.mapSeries(this.getOnSessionStartedHandlers(), (fn: Function) => fn(voxaEvent, voxaReply));
          // Route the request to the proper handler which may have been overriden.
          return await requestHandler(voxaEvent, voxaReply);
        }

        default: {
          return await requestHandler(voxaEvent, voxaReply);
        }
      }
    } catch(error) {
      return await this.handleErrors(voxaEvent, error, ReplyClass)
    }
  }

  /*
   * Request handlers are in charge of responding to the different request types alexa sends,
   * in general they will defer to the proper event handler
   */
  registerRequestHandler(requestType: string): void {
    // .filter(requestType => !this.requestHandlers[requestType])
    if (this.requestHandlers[requestType]) {
      return;
    }

    const eventName = `on${requestType}`;
    this.registerEvent(eventName);

    this.requestHandlers[requestType] = async (voxaEvent: IVoxaEvent, reply: VoxaReply): Promise<VoxaReply> => {
      log(eventName);
      const capitalizedEventName = _.upperFirst(_.camelCase(eventName));
      const result = await bluebird.mapSeries(this[`get${capitalizedEventName}Handlers`](), (fn: Function): VoxaReply => fn.call(this, voxaEvent, reply))
      const lastReply = _(result).filter().last();
      // if the handlers produced a reply we return the last one
      if (lastReply) {
        return lastReply;
      }

      // else we return the one we started with
      return reply;
    };
  }

  /*
   * Event handlers are array of callbacks that get executed when an event is triggered
   * they can return a promise if async execution is needed,
   * most are registered with the voxaEvent handlers
   * however there are some that don't map exactly to a voxaEvent and we register them in here,
   * override the method to add new events.
   */
  registerEvents(): void {
    // Called when the request starts.
    this.registerEvent('onRequestStarted');

    // Called when the session starts.
    this.registerEvent('onSessionStarted');

    // Called when the user ends the session.
    this.registerEvent('onSessionEnded');

    // Sent whenever there's an unhandled error in the onIntent code
    this.registerEvent('onError');
    //
    // this are all StateMachine events
    this.registerEvent('onBeforeStateChanged');
    this.registerEvent('onAfterStateChanged');
    this.registerEvent('onBeforeReplySent');
    // Sent when the state machine failed to return a carrect reply
    this.registerEvent('onUnhandledState');
  }

  /*
   * Create an event handler register for the provided eventName
   * This will keep 2 separate lists of event callbacks
   */
  registerEvent(eventName: string): void {
    this.eventHandlers[eventName] = [];
    this.eventHandlers[`_${eventName}`] = []; // we keep a separate list of event callbacks to alway execute them last
    if (!this[eventName]) {
      const capitalizedEventName = _.upperFirst(_.camelCase(eventName));
      this[eventName] = (callback: Function, atLast: boolean) => {
        if (atLast) {
          this.eventHandlers[`_${eventName}`].push(callback.bind(this));
        } else {
          this.eventHandlers[eventName].push(callback.bind(this));
        }
      };

      this[`get${capitalizedEventName}Handlers`] = (): Array<Function> => _.concat(this.eventHandlers[eventName], this.eventHandlers[`_${eventName}`]);
    }
  }

  onState(stateName: string, handler: Function | Transition, intents: Array<string> | string = []): void {
    const state = _.get(this.states, stateName, { name: stateName });
    const stateEnter = _.get(state, 'enter', {});

    if (_.isFunction(handler)) {
      if (intents.length === 0) {
        stateEnter.entry = handler;
      } else if (_.isString(intents)) {
        stateEnter[intents] = handler;
      } else if (_.isArray(intents)) {
        _.merge(stateEnter, _(intents)
          .map(intentName => [intentName, handler])
          .fromPairs()
          .value());
      }
      state.enter = stateEnter;
      this.states[stateName] = state;
    } else {
      state.to = handler;
      this.states[stateName] = state;
    }
  }

  onIntent(intentName: string, handler: Function): void {
    if (!this.states.entry) {
      this.states.entry = { to: {}, name: 'entry' };
    }
    this.states.entry.to[intentName] = intentName;
    this.onState(intentName, handler);
  }

  async runStateMachine(voxaEvent: IVoxaEvent, reply: VoxaReply): Promise<VoxaReply> {
    let fromState = voxaEvent.session.new ? 'entry' : _.get(voxaEvent, 'session.attributes.model._state', 'entry');
    if (fromState === 'die') {
      fromState = 'entry';
    }
    const stateMachine = new StateMachine(fromState, {
      states: this.states,
      onBeforeStateChanged: this.getOnBeforeStateChangedHandlers(),
      onAfterStateChanged: this.getOnAfterStateChangedHandlers(),
      onUnhandledState: this.getOnUnhandledStateHandlers(),
    });

    log('Starting the state machine from %s state', fromState);

    const transition: Transition = await stateMachine.runTransition(voxaEvent, reply);
    if (!_.isString(transition.to) && transition.to.isTerminal) {
      await this.handleOnSessionEnded(voxaEvent, reply);
    }

    const onBeforeReplyHandlers = this.getOnBeforeReplySentHandlers();
    log('Running onBeforeReplySent');
    await bluebird.mapSeries(onBeforeReplyHandlers, (fn: Function) => fn(voxaEvent, reply, transition));

    return reply
  }

  async transformRequest(voxaEvent: IVoxaEvent): Promise<void> {
    await this.i18nextPromise
    const model: Model = await this.config.Model.fromEvent(voxaEvent)
    voxaEvent.model = model;
    voxaEvent.t = i18n.getFixedT(voxaEvent.request.locale);
    log('Initialized model like %s', JSON.stringify(voxaEvent.model));
  }
}
