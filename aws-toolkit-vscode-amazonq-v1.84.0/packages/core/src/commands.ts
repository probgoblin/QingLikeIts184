/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AWS Toolkit extension commands and implementations.
 * TODO: We should drop this into packages/toolkit, but some of the commands are required for running tests.
 * Tests in the core lib cannot yet work with extension activation from packages/toolkit, so the core lib is
 * activated from ./extension.ts instead.
 * A pre-req for moving this is also moving the Toolkit related tests to packages/toolkit.
 */

import * as vscode from 'vscode'
import globals, { isWeb } from './shared/extensionGlobals'

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

import { Auth } from './auth/auth'
import { TreeNode } from './shared/treeview/resourceTreeDataProvider'
import { getResourceFromTreeNode } from './shared/treeview/utils'
import { Connection, createSsoProfile } from './auth/connection'
import {
    createIamItem,
    createSsoItem,
    createBuilderIdItem,
    createStartUrlPrompter,
    showRegionPrompter,
    createBuilderIdConnection,
    signout,
    promptAndUseConnection,
} from './auth/utils'
import { showCodeWhispererConnectionPrompt } from './codewhisperer/util/showSsoPrompt'
import { CommonAuthWebview } from './login/webview/vue/backend'
import { AuthSource, AuthSources } from './login/webview/util'
import { ServiceItemId, isServiceItemId } from './login/webview/vue/types'
import { authHelpUrl } from './shared/constants'
import { getIdeProperties } from './shared/extensionUtilities'
import { telemetry } from './shared/telemetry/telemetry'
import { createCommonButtons } from './shared/ui/buttons'
import { showQuickPick } from './shared/ui/pickerPrompter'
import { Instance } from './shared/utilities/typeConstructors'
import { openUrl } from './shared/utilities/vsCodeUtils'
import { Commands, VsCodeCommandArg, placeholder, vscodeComponent } from './shared/vscode/commands2'
import { isValidResponse } from './shared/wizards/wizard'
import { CancellationError } from './shared/utilities/timeoutUtils'
import { ToolkitError } from './shared/errors'
import { getContext, setContext } from './shared/vscode/setContext'

function switchConnections(auth: Auth | TreeNode | unknown) {
    if (!(auth instanceof Auth)) {
        try {
            auth = getResourceFromTreeNode(auth, Instance(Auth))
        } catch {
            // Fall back in case this command is called from something in package.json.
            // If so, then the value of auth will be unusable.
            auth = Auth.instance
        }
    }

    return promptAndUseConnection(auth as Auth)
}

export function registerCommands(context: vscode.ExtensionContext) {
    const addConnection = Commands.register(
        { id: 'aws.toolkit.auth.addConnection', telemetryThrottleMs: false },
        async () => {
            const items = [createBuilderIdItem(), createSsoItem(), createIamItem()]

            const resp = await showQuickPick(items, {
                title: localize('aws.auth.addConnection.title', 'Add a Connection to {0}', getIdeProperties().company),
                placeholder: localize('aws.auth.addConnection.placeholder', 'Select a connection option'),
                buttons: createCommonButtons() as vscode.QuickInputButton[],
            })
            if (!isValidResponse(resp)) {
                telemetry.ui_click.emit({ elementId: 'connection_optionescapecancel' })
                throw new CancellationError('user')
            }

            switch (resp) {
                case 'iam':
                    return await globals.awsContextCommands.onCommandCreateCredentialsProfile()
                case 'sso': {
                    const startUrlPrompter = await createStartUrlPrompter('IAM Identity Center')
                    const startUrl = await startUrlPrompter.prompt()
                    if (!isValidResponse(startUrl)) {
                        throw new CancellationError('user')
                    }
                    telemetry.ui_click.emit({ elementId: 'connection_startUrl' })

                    const region = await showRegionPrompter()

                    const conn = await Auth.instance.createConnection(createSsoProfile(startUrl, region.id))
                    return Auth.instance.useConnection(conn)
                }
                case 'builderId': {
                    return createBuilderIdConnection(Auth.instance)
                }
            }
        }
    )

    const manageConnections = Commands.register(
        { id: 'aws.toolkit.auth.manageConnections', compositeKey: { 1: 'source' } },
        async (_: VsCodeCommandArg, source: AuthSource, serviceToShow?: ServiceItemId, blocking?: boolean) => {
            if (_ !== placeholder) {
                source = AuthSources.vscodeComponent
            }

            if (isWeb()) {
                // TODO: CW no longer exists in toolkit. This should be moved to Amazon Q
                if (source.toLowerCase().includes('codewhisperer')) {
                    // Show CW specific quick pick for CW connections
                    return showCodeWhispererConnectionPrompt()
                }
                return addConnection.execute()
            }

            if (!isServiceItemId(serviceToShow)) {
                serviceToShow = undefined
            }

            CommonAuthWebview.authSource = source
            await vscode.commands.executeCommand('aws.explorer.setLoginService', serviceToShow)
            await setContext('aws.explorer.showAuthView', true)

            // While the auth view is open, we want to be blocking (if the command has been specified to be blocking)
            const authWindowPromise = new Promise<void>((resolve) => {
                if (!blocking) {
                    resolve()
                }

                const check = globals.clock.setInterval(() => {
                    if (getContext('aws.explorer.showAuthView') === false) {
                        clearInterval(check)
                        resolve()
                    }
                }, 500)
            })

            await vscode.commands.executeCommand('aws.toolkit.AmazonCommonAuth.focus')
            await authWindowPromise
        }
    )

    context.subscriptions.push(
        addConnection,
        manageConnections,
        Commands.register('aws.toolkit.auth.help', async () => {
            await openUrl(vscode.Uri.parse(authHelpUrl))
            telemetry.aws_help.emit()
        }),
        Commands.register('aws.toolkit.auth.switchConnections', (auth: Auth | TreeNode | unknown) => {
            telemetry.ui_click.emit({ elementId: 'devtools_connectToAws' })
            return switchConnections(auth)
        }),
        Commands.register('_aws.toolkit.auth.useIamCredentials', (auth: Auth) => {
            telemetry.ui_click.emit({ elementId: 'explorer_IAMselect_VSCode' })
            return promptAndUseConnection(auth, 'iam')
        }),
        Commands.register('aws.toolkit.credentials.edit', () => globals.awsContextCommands.onCommandEditCredentials()),
        Commands.register('aws.toolkit.credentials.profile.create', async () => {
            try {
                await globals.awsContextCommands.onCommandCreateCredentialsProfile()
            } finally {
                telemetry.aws_createCredentials.emit()
            }
        }),
        Commands.register('aws.toolkit.login', async () => {
            const connections = await Auth.instance.listConnections()
            if (connections.length === 0) {
                const source: AuthSource = vscodeComponent
                return manageConnections.execute(placeholder, source)
            } else {
                return switchConnections(Auth.instance)
            }
        }),
        Commands.register('aws.toolkit.auth.signout', async () => {
            telemetry.ui_click.emit({ elementId: 'devtools_signout' })
            await signout(Auth.instance)
        }),
        Commands.register('_aws.toolkit.auth.autoConnect', Auth.instance.tryAutoConnect),
        Commands.register('_aws.toolkit.auth.reauthenticate', async (auth: Auth, conn: Connection) => {
            try {
                return await auth.reauthenticate(conn)
            } catch (err) {
                throw ToolkitError.chain(err, 'Unable to authenticate connection')
            }
        })
    )
}
