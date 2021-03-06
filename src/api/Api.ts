import "cross-fetch/polyfill";

import * as BN from "bn.js";
import { anyToHex, jsonReplacer, jsonReviver } from "eth-utils";
import { merge, Subject } from "rxjs";
import { ErrorSubject, UniqueBehaviorSubject } from "rxjs-addons";
import { map } from "rxjs/operators";
import { IAccountAttributes, IAccountDeviceAttributes } from "../account";
import { IAppAttributes } from "../app";
import { ISdkSettings } from "../sdk";
import { IDevice, IDeviceAttributes } from "../device";
import { ApiConnection } from "./ApiConnection";
import { ApiSession } from "./ApiSession";
import { ApiConnectionStates } from "./constants";
import {
  errApiInvalidConnectionState,
  errApiUnknownHttpEndpoint,
  errApiUnknownWsEndpoint,
} from "./errors";
import { ApiEvents, decodeApiEvent, encodeApiEvent, IApiEvent } from "./events";
import {
  IApi,
  IApiConnection, IApiListData,
  IApiOptions,
  IApiRequest,
  IApiResponse,
  IApiSession,
} from "./interfaces";

/**
 * Api
 */
export class Api implements IApi {

  private static buildEndpoint(protocol: "http" | "ws", options: IApiOptions = null): string {
    let result: string = null;

    if (options) {
      const { host, port, ssl } = options;
      result = `${protocol}${ssl ? "s" : ""}://${host || "localhost"}${port ? `:${port}` : ""}`;
    }

    return result;
  }

  /**
   * session
   */
  public session: IApiSession = null;

  /**
   * options subject
   */
  public options$ = new UniqueBehaviorSubject<IApiOptions>();

  /**
   * event subject
   */
  public event$ = new Subject<IApiEvent>();

  /**
   * error subject
   */
  public error$ = new ErrorSubject();

  private endpoints: {
    http: string
    ws: string;
  } = null;

  private reconnectInterval: any = null;

  /**
   * constructor
   * @param device
   * @param options
   * @param connection
   */
  constructor(device: IDevice, options: IApiOptions = null, public connection: IApiConnection = new ApiConnection()) {
    this.session = new ApiSession(device);

    this.options = options;

    this
      .options$
      .subscribe((options) => {
        this.endpoints = {
          ws: Api.buildEndpoint("ws", options),
          http: Api.buildEndpoint("http", options),
        };

        this.session.setAsDestroyed();
      });

    this
      .connection
      .data$
      .pipe(
        map((data) => decodeApiEvent(data)),
      )
      .subscribe(this.event$);

    // auto auth
    merge(this.options$, device.address$)
      .pipe(
        map(() => (
          this.options &&
          !!device.address &&
          !this.options.manualAuth
        )),
      )
      .subscribe((canAuth) => {
        if (canAuth) {
          this.error$.wrapAsync(() => this.createSession());
        } else {
          this.destroySession();
        }
      });
  }

  /**
   * options getter
   */
  public get options(): IApiOptions {
    return this.options$.value;
  }

  /**
   * options setter
   * @param options
   */
  public set options(options: IApiOptions) {
    this.options$.next(options);
  }

  /**
   * creates session
   */
  public async createSession(): Promise<void> {
    try {
      this.session.setAsVerifying();

      const { hash } = await this.createSessionHash();
      const { signer, signature } = await this.session.signHash(hash);
      const { token } = await this.verifySessionHash({
        hash,
        signer,
        signature,
      });

      this.session.setAsVerified(token);
    } catch (err) {
      this.session.setAsDestroyed();
    }

    this.openConnection();
  }

  /**
   * destroys session
   */
  public destroySession(): void {
    this.session.setAsDestroyed();
    this.closeConnection();
  }

  /**
   * mute connection
   */
  public muteConnection(): void {
    this.sendEvent({
      type: ApiEvents.Types.MuteConnection,
    });
  }

  /**
   * un mute connection
   */
  public unMuteConnection(): void {
    this.sendEvent({
      type: ApiEvents.Types.UnMuteConnection,
    });
  }

  /**
   * signs secure action
   * @param recipient
   * @param signature
   */
  public signSecureAction(recipient: string, signature: Buffer): void {
    this.sendEvent<ApiEvents.Payloads.ISignedSecureAction>({
      type: ApiEvents.Types.SignedSecureAction,
      payload: {
        recipient,
        signature: anyToHex(signature, { add0x: true }),
      },
    });
  }

  /**
   * gets settings
   */
  public async getSettings(): Promise<ISdkSettings> {
    const { data } = await this.call<any, ISdkSettings>({
      method: "GET",
      path: "settings",
    });

    return data || null;
  }

  /**
   * gets account
   * @param account
   */
  public async getAccount({ ensName }: Partial<IAccountAttributes>): Promise<IAccountAttributes> {
    const { data } = await this.call<any, IAccountAttributes>({
      method: "GET",
      path: `account/${ensName}`,
    });

    return data || null;
  }

  /**
   * gets account devices
   * @param account
   */
  public async getAccountDevices({ ensName }: Partial<IAccountAttributes>): Promise<IAccountDeviceAttributes[]> {
    const { data } = await this.call<any, IAccountDeviceAttributes[]>({
      method: "GET",
      path: `account/${ensName}/device`,
    });

    return data || null;
  }

  /**
   * gets account device
   * @param account
   * @param device
   * @param touch
   */
  public async getAccountDevice({ ensName }: Partial<IAccountAttributes>, { address }: Partial<IDeviceAttributes>, touch = false): Promise<IAccountDeviceAttributes> {
    const { data } = await this.call<any, IAccountDeviceAttributes>({
      method: "GET",
      path: `account/${ensName}/device/${address}?touch=${touch ? "1" : ""}`,
    });

    return data || null;
  }

  /**
   * creates account
   * @param account
   */
  public async createAccount({ ensName }: Partial<IAccountAttributes>): Promise<IAccountAttributes> {
    const { data } = await this.call<any, IAccountAttributes>({
      method: "POST",
      path: "account",
      body: {
        ensName,
      },
    });

    return data || null;
  }

  /**
   * gets account guardian deployment signature
   * @param account
   * @param signature
   */
  public async getAccountGuardianDeploymentSignature({ ensName }: Partial<IAccountAttributes>, signature: Buffer): Promise<Buffer> {
    const { data } = await this.call<any, Buffer>({
      method: "PUT",
      path: `account/${ensName}`,
      body: {
        signature,
      },
    });

    return data || null;
  }

  /**
   * creates account device
   * @param account
   * @param device
   * @param app
   * @param limit
   * @param signature
   */
  public async createAccountDevice(
    { ensName }: Partial<IAccountAttributes>,
    device: Partial<IDeviceAttributes>,
    app: Partial<IAppAttributes> = null,
    limit: BN.IBN = null,
  ): Promise<IAccountDeviceAttributes> {
    const { data } = await this.call<any, IAccountDeviceAttributes>({
      method: "POST",
      path: `account/${ensName}/device`,
      body: {
        device: {
          address: device.address,
        },
        app: (
          app
            ? {
              address: app.address,
            }
            : null
        ),
        limit,
      },
    });

    return data || null;
  }

  /**
   * deploys account device
   * @param ensName
   * @param address
   * @param nonce
   * @param signature
   * @param gasPrice
   */
  public async deployAccountDevice(
    { ensName }: Partial<IAccountAttributes>,
    { address }: Partial<IDeviceAttributes>,
    nonce: BN.IBN,
    signature: Buffer,
    gasPrice: BN.IBN,
  ): Promise<IAccountDeviceAttributes> {
    const { data } = await this.call<any, IAccountDeviceAttributes>({
      method: "PUT",
      path: `account/${ensName}/device/${address}`,
      body: {
        nonce,
        signature,
        gasPrice,
      },
    });

    return data || null;
  }

  /**
   * gets apps
   * @param page
   */
  public async getApps(page: number = 0): Promise<IApiListData<IAppAttributes>> {
    const { data } = await this.call<any, IApiListData<IAppAttributes>>({
      method: "GET",
      path: `app?page=${page}`,
    });

    return data || null;
  }

  /**
   * get app
   * @param appNameOrAddress
   */
  public async getApp(appNameOrAddress: string): Promise<IAppAttributes> {
    const { data } = await this.call<any, IAppAttributes>({
      method: "GET",
      path: `app/${appNameOrAddress}`,
    });

    return data || null;
  }

  private async call<B = any, D = any>(req: IApiRequest<B>): Promise<IApiResponse<D>> {
    if (!this.endpoints.http) {
      throw errApiUnknownHttpEndpoint;
    }

    const { method, path, body } = req;

    let text: string = null;

    try {

      const res = await fetch(`${this.endpoints.http}/${path}`, {
        method,
        headers: new Headers({
          "Content-Type": "application/json",
          "Pragma": "no-cache",
          "Cache-Control": "no-cache",
          "X-Session-Token": this.session.token || "",
        }),
        ...(
          method !== "GET" &&
          method !== "HEAD"
            ? { body: JSON.stringify(body || {}, jsonReplacer) }
            : {}
        ),
      });
      text = await res.text();
    } catch (err) {
      //
    }

    return text ? JSON.parse(text, jsonReviver) : {};
  }

  private sendEvent<T = any>(event: IApiEvent<T>): void {
    if (!this.connection.opened) {
      throw errApiInvalidConnectionState;
    }

    this.connection.send(
      encodeApiEvent(event),
    );
  }

  private async createSessionHash<D = { hash: Buffer }>(): Promise<D> {
    const { data } = await this.call<any, D>({
      method: "POST",
      path: "session",
    });

    return data || null;
  }

  private async verifySessionHash<B = { signer: string, hash: Buffer, signature: Buffer }, D = { token: string }>(body: B): Promise<D> {
    const { data } = await this.call<B, D>({
      method: "PUT",
      path: "session",
      body,
    });

    return data || null;
  }

  private openConnection(): void {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
    }

    if (!this.endpoints.ws) {
      throw errApiUnknownWsEndpoint;
    }

    if (!this.session.verified) {
      return;
    }

    const { reconnectTimeout } = this.options;

    const open = () => this.connection.open(
      this.endpoints.ws,
      this.session.token,
    );

    open();

    if (reconnectTimeout) {
      this.reconnectInterval = setInterval(
        () => {
          switch (this.connection.state) {
            case ApiConnectionStates.Closed:
              open();
              break;
          }
        },
        reconnectTimeout,
      );
    }
  }

  private closeConnection(): void {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
    }

    this.connection.close(true);
  }
}
