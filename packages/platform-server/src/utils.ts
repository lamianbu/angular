/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ApplicationRef, InjectionToken, NgModuleRef, PlatformRef, Provider, Renderer2, StaticProvider, Type, ɵannotateForHydration as annotateForHydration, ɵIS_HYDRATION_FEATURE_ENABLED as IS_HYDRATION_FEATURE_ENABLED, ɵisPromise} from '@angular/core';
import {first} from 'rxjs/operators';

import {PlatformState} from './platform_state';
import {platformDynamicServer} from './server';
import {BEFORE_APP_SERIALIZED, INITIAL_CONFIG} from './tokens';

interface PlatformOptions {
  document?: string|Document;
  url?: string;
  platformProviders?: Provider[];
}

function _getPlatform(
    platformFactory: (extraProviders: StaticProvider[]) => PlatformRef,
    options: PlatformOptions): PlatformRef {
  const extraProviders = options.platformProviders ?? [];
  return platformFactory([
    {provide: INITIAL_CONFIG, useValue: {document: options.document, url: options.url}},
    extraProviders
  ]);
}

/**
 * Adds the `ng-server-context` attribute to host elements of all bootstrapped components
 * within a given application.
 */
function appendServerContextInfo(serverContext: string, applicationRef: ApplicationRef) {
  applicationRef.components.forEach(componentRef => {
    const renderer = componentRef.injector.get(Renderer2);
    const element = componentRef.location.nativeElement;
    if (element) {
      renderer.setAttribute(element, 'ng-server-context', serverContext);
    }
  });
}

function _render<T>(
    platform: PlatformRef,
    bootstrapPromise: Promise<NgModuleRef<T>|ApplicationRef>): Promise<string> {
  return bootstrapPromise.then((moduleOrApplicationRef) => {
    const environmentInjector = moduleOrApplicationRef.injector;
    const applicationRef: ApplicationRef = moduleOrApplicationRef instanceof ApplicationRef ?
        moduleOrApplicationRef :
        environmentInjector.get(ApplicationRef);
    const serverContext =
        sanitizeServerContext(environmentInjector.get(SERVER_CONTEXT, DEFAULT_SERVER_CONTEXT));
    return applicationRef.isStable.pipe((first((isStable: boolean) => isStable)))
        .toPromise()
        .then(() => {
          appendServerContextInfo(serverContext, applicationRef);

          const platformState = platform.injector.get(PlatformState);

          const asyncPromises: Promise<any>[] = [];

          if (applicationRef.injector.get(IS_HYDRATION_FEATURE_ENABLED, false)) {
            annotateForHydration(applicationRef, platformState.getDocument());
          }

          // Run any BEFORE_APP_SERIALIZED callbacks just before rendering to string.
          const callbacks = environmentInjector.get(BEFORE_APP_SERIALIZED, null);

          if (callbacks) {
            for (const callback of callbacks) {
              try {
                const callbackResult = callback();
                if (ɵisPromise(callbackResult)) {
                  // TODO: in TS3.7, callbackResult is void.
                  asyncPromises.push(callbackResult as any);
                }

              } catch (e) {
                // Ignore exceptions.
                console.warn('Ignoring BEFORE_APP_SERIALIZED Exception: ', e);
              }
            }
          }

          const complete = () => {
            const output = platformState.renderToString();
            platform.destroy();
            return output;
          };

          if (asyncPromises.length === 0) {
            return complete();
          }

          return Promise
              .all(asyncPromises.map(asyncPromise => {
                return asyncPromise.catch(e => {
                  console.warn('Ignoring BEFORE_APP_SERIALIZED Exception: ', e);
                });
              }))
              .then(complete);
        });
  });
}

/**
 * Specifies the value that should be used if no server context value has been provided.
 */
const DEFAULT_SERVER_CONTEXT = 'other';

/**
 * An internal token that allows providing extra information about the server context
 * (e.g. whether SSR or SSG was used). The value is a string and characters other
 * than [a-zA-Z0-9\-] are removed. See the default value in `DEFAULT_SERVER_CONTEXT` const.
 */
export const SERVER_CONTEXT = new InjectionToken<string>('SERVER_CONTEXT');

/**
 * Sanitizes provided server context:
 * - removes all characters other than a-z, A-Z, 0-9 and `-`
 * - returns `other` if nothing is provided or the string is empty after sanitization
 */
function sanitizeServerContext(serverContext: string): string {
  const context = serverContext.replace(/[^a-zA-Z0-9\-]/g, '');
  return context.length > 0 ? context : DEFAULT_SERVER_CONTEXT;
}

/**
 * Bootstraps an application using provided NgModule and serializes the page content to string.
 *
 * @param moduleType A reference to an NgModule that should be used for bootstrap.
 * @param options Additional configuration for the render operation:
 *  - `document` - the document of the page to render, either as an HTML string or
 *                 as a reference to the `document` instance.
 *  - `url` - the URL for the current render request.
 *  - `extraProviders` - set of platform level providers for the current render request.
 *
 * @publicApi
 */
export function renderModule<T>(moduleType: Type<T>, options: {
  document?: string|Document,
  url?: string,
  extraProviders?: StaticProvider[],
}): Promise<string> {
  const {document, url, extraProviders: platformProviders} = options;
  const platform = _getPlatform(platformDynamicServer, {document, url, platformProviders});
  return _render(platform, platform.bootstrapModule(moduleType));
}

/**
 * Bootstraps an instance of an Angular application and renders it to a string.

 * ```typescript
 * const bootstrap = () => bootstrapApplication(RootComponent, appConfig);
 * const output: string = await renderApplication(bootstrap);
 * ```
 *
 * @param bootstrap A method that when invoked returns a promise that returns an `ApplicationRef`
 *     instance once resolved.
 * @param options Additional configuration for the render operation:
 *  - `document` - the document of the page to render, either as an HTML string or
 *                 as a reference to the `document` instance.
 *  - `url` - the URL for the current render request.
 *  - `platformProviders` - the platform level providers for the current render request.
 *
 * @returns A Promise, that returns serialized (to a string) rendered page, once resolved.
 *
 * @publicApi
 * @developerPreview
 */
export function renderApplication<T>(bootstrap: () => Promise<ApplicationRef>, options: {
  document?: string|Document,
  url?: string,
  platformProviders?: Provider[],
}): Promise<string> {
  const platform = _getPlatform(platformDynamicServer, options);

  return _render(platform, bootstrap());
}
