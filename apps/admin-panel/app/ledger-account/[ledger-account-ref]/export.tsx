"use client"

import React, { useState, useEffect, useRef } from "react"
import { gql } from "@apollo/client"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@lana/web/ui/dialog"
import { Button } from "@lana/web/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lana/web/ui/select"
import { Loader2, FileDown, FileUp, CheckCircle, Clock } from "lucide-react"

import { formatDate } from "@lana/web/utils"

import {
  useAccountingCsvsForLedgerAccountIdQuery,
  useLedgerAccountCsvCreateMutation,
  useAccountingCsvDownloadLinkGenerateMutation,
  DocumentStatus,
} from "@/lib/graphql/generated"

gql`
  query AccountingCsvsForLedgerAccountId(
    $ledgerAccountId: UUID!
    $first: Int!
    $after: String
  ) {
    accountingCsvsForLedgerAccountId(
      ledgerAccountId: $ledgerAccountId
      first: $first
      after: $after
    ) {
      edges {
        node {
          id
          documentId
          status
          createdAt
        }
        cursor
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }

  query LastAccountingCsvForLedgerAccountId(
    $ledgerAccountId: UUID!
  ) {
    latestAccountingCsvForLedgerId(ledgerAccountId: $ledgerAccountId) {
        id
        documentId
        status
        createdAt
    }
  }
  
  mutation LedgerAccountCsvCreate($input: LedgerAccountCsvCreateInput!) {
    ledgerAccountCsvCreate(input: $input) {
      accountingCsvDocument {
        id
        documentId
        status
        createdAt
      }
    }
  }

  mutation AccountingCsvDownloadLinkGenerate(
    $input: AccountingCsvDownloadLinkGenerateInput!
  ) {
    accountingCsvDownloadLinkGenerate(input: $input) {
      link {
        url
        csvId
      }
    }
  }
`

type CsvOption = {
  id: string
  documentId: string
  label: string
  status: DocumentStatus
  createdAt: string
}

type ExportCsvDialogProps = {
  isOpen: boolean
  onClose: () => void
  ledgerAccountId: string
}

export const ExportCsvDialog: React.FC<ExportCsvDialogProps> = ({
  isOpen,
  onClose,
  ledgerAccountId,
}) => {
  const t = useTranslations("ChartOfAccountsLedgerAccount.exportCsv")
  const [isDownloading, setIsDownloading] = useState(false)

  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const pollingCsvIdRef = useRef<string | null>(null)

  const { data, loading, refetch } = useLatestCsvForLedgerAccountQuery({
    variables: { ledgerAccountId },
    skip: !isOpen,
    fetchPolicy: "network-only",
    pollInterval: data?.latestCsvForLedgerAccount?.isProcessing ? 2000 : 0,
    notifyOnNetworkStatusChange: false,
  })

  const [createCsv, { loading: createLoading }] = useLedgerAccountCsvCreateMutation()
  const [generateDownloadLink] = useAccountingCsvDownloadLinkGenerateMutation()

  const latestCsv = data?.latestCsvForLedgerAccount

  const startPolling = (csvId: string) => {
    pollingCsvIdRef.current = csvId
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
    }
    pollingIntervalRef.current = setInterval(() => {
      refetch().catch(() => stopPolling())
    }, 2000)
  }

  const stopPolling = () => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
      pollingIntervalRef.current = null
    }
    pollingCsvIdRef.current = null
  }

  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
      }
    }
  }, [])

  const handleCreateNewCsv = async () => {
    try {
      const result = await createCsv({
        variables: {
          input: {
            ledgerAccountId,
          },
        },
      })

      if (result.data) {
        const newCsvId =
          result.data.ledgerAccountCsvCreate.accountingCsvDocument.documentId
        toast.success(t("csvCreating"))
        startPolling(newCsvId)
        await refetch()
      }
    } catch (err) {
      console.error("Error creating CSV:", err)
      toast.error(t("errors.createFailed"))
    }
  }

  const handleDownload = async () => {
    if (!latestCsv?.canDownload) {
      toast.error(t("errors.notReady"))
      return
    }

    try {
      setIsDownloading(true)
      const result = await generateDownloadLink({
        variables: { input: { documentId: latestCsv.documentId } },
      })

      if (result.data?.accountingCsvDownloadLinkGenerate.link.url) {
        window.open(result.data.accountingCsvDownloadLinkGenerate.link.url, "_blank")
        toast.success(t("downloadStarted"))
      }
    } catch (err) {
      toast.error(t("errors.downloadFailed"))
    } finally {
      setIsDownloading(false)
    }
  }

  const handleClose = () => {
    stopPolling()
    onClose()
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {latestCsv && (
              <div className="space-y-4">
                <h3 className="text-sm font-medium">{t("currentExport")}</h3>

                <div className="p-4 border rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-muted-foreground">
                    {t("generatedAt", { date: formatDate(latestCsv.generatedAt) })}
                  </span>
                    <CsvStatusBadge csv={latestCsv} />
                  </div>

                  {latestCsv.rowCount && (
                      <p className="text-sm text-muted-foreground">
                        {t("rowCount", { count: latestCsv.rowCount })}
                      </p>
                  )}

                  {latestCsv.isProcessing ? (
                      <div className="flex items-center mt-3">
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        <span className="text-sm">{t("processing")}</span>
                      </div>
                  ) : (
                      <Button
                          className="w-full mt-3"
                          onClick={handleDownload}
                          disabled={!latestCsv.canDownload || isDownloading}
                      >
                        {isDownloading ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                            <FileDown className="h-4 w-4 mr-2" />
                        )}
                        {t("buttons.download")}
                      </Button>
                  )}
                </div>
              </div>
          )}

          <div className="border-t pt-4">
            <h3 className="text-sm font-medium mb-3">{t("createNew")}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t("createNewDescription")}
            </p>
            <Button
              onClick={handleCreateNewCsv}
              disabled={createLoading}
              className="w-full"
            >
              {createLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  {t("buttons.generating")}
                </>
              ) : (
                <>
                  <FileUp className="h-4 w-4 mr-2" />
                  {t("buttons.generate")}
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
