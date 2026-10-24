
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "analytics_thresholds": {
                  Row: {
                    "description": string,"key": string,"label": string,"updated_at": string,"updated_by": string | null,"value_hours": number
                  }
                  Insert: {
                    "description": string,"key": string,"label": string,"updated_at"?: string,"updated_by"?: string | null,"value_hours": number
                  }
                  Update: {
                    "description"?: string,"key"?: string,"label"?: string,"updated_at"?: string,"updated_by"?: string | null,"value_hours"?: number
                  }
                  Relationships: [
                    
                  ]
                },"app_settings": {
                  Row: {
                    "key": string,"updated_at": string,"updated_by": string | null,"value": NonNullable<Json>
                  }
                  Insert: {
                    "key": string,"updated_at"?: string,"updated_by"?: string | null,"value": NonNullable<Json>
                  }
                  Update: {
                    "key"?: string,"updated_at"?: string,"updated_by"?: string | null,"value"?: NonNullable<Json>
                  }
                  Relationships: [
                    
                  ]
                },"audit_events": {
                  Row: {
                    "action": string,"details": NonNullable<Json>,"id": number,"occurred_at": string,"user_id": string | null
                  }
                  Insert: {
                    "action": string,"details"?: NonNullable<Json>,"id"?: never,"occurred_at"?: string,"user_id"?: string | null
                  }
                  Update: {
                    "action"?: string,"details"?: NonNullable<Json>,"id"?: never,"occurred_at"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"import_errors": {
                  Row: {
                    "error_code": string,"id": number,"import_run_id": string,"raw_row": Json | null,"recorded_at": string,"source_row_number": number | null,"ticket_id": number | null,"validation_error": string
                  }
                  Insert: {
                    "error_code": string,"id"?: never,"import_run_id": string,"raw_row"?: Json | null,"recorded_at"?: string,"source_row_number"?: number | null,"ticket_id"?: number | null,"validation_error": string
                  }
                  Update: {
                    "error_code"?: string,"id"?: never,"import_run_id"?: string,"raw_row"?: Json | null,"recorded_at"?: string,"source_row_number"?: number | null,"ticket_id"?: number | null,"validation_error"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_errors_import_run_id_fkey"
      columns: ["import_run_id"]
isOneToOne: false
      referencedRelation: "import_runs"
      referencedColumns: ["id"]
    }
                  ]
                },"import_job_events": {
                  Row: {
                    "actor": string | null,"details": NonNullable<Json>,"event": string,"id": number,"job_id": string,"occurred_at": string
                  }
                  Insert: {
                    "actor"?: string | null,"details"?: NonNullable<Json>,"event": string,"id"?: never,"job_id": string,"occurred_at"?: string
                  }
                  Update: {
                    "actor"?: string | null,"details"?: NonNullable<Json>,"event"?: string,"id"?: never,"job_id"?: string,"occurred_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_job_events_job_id_fkey"
      columns: ["job_id"]
isOneToOne: false
      referencedRelation: "import_jobs"
      referencedColumns: ["id"]
    }
                  ]
                },"import_job_issues": {
                  Row: {
                    "code": string,"column_name": string | null,"id": number,"job_id": string,"line": number | null,"message": string,"row_number": number | null,"severity": string,"ticket_id": number | null,"value_excerpt": string | null
                  }
                  Insert: {
                    "code": string,"column_name"?: string | null,"id"?: never,"job_id": string,"line"?: number | null,"message": string,"row_number"?: number | null,"severity": string,"ticket_id"?: number | null,"value_excerpt"?: string | null
                  }
                  Update: {
                    "code"?: string,"column_name"?: string | null,"id"?: never,"job_id"?: string,"line"?: number | null,"message"?: string,"row_number"?: number | null,"severity"?: string,"ticket_id"?: number | null,"value_excerpt"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_job_issues_job_id_fkey"
      columns: ["job_id"]
isOneToOne: false
      referencedRelation: "import_jobs"
      referencedColumns: ["id"]
    }
                  ]
                },"import_job_rows": {
                  Row: {
                    "applied_action": string | null,"applied_at": string | null,"attachments": NonNullable<Json>,"error_code": string | null,"error_message": string | null,"is_valid": boolean,"job_id": string,"line": number | null,"organization_id": number | null,"planned_action": string | null,"raw": Json | null,"record": Json | null,"row_hash": string | null,"row_number": number,"theme": Json | null,"ticket_id": number | null
                  }
                  Insert: {
                    "applied_action"?: string | null,"applied_at"?: string | null,"attachments"?: NonNullable<Json>,"error_code"?: string | null,"error_message"?: string | null,"is_valid": boolean,"job_id": string,"line"?: number | null,"organization_id"?: number | null,"planned_action"?: string | null,"raw"?: Json | null,"record"?: Json | null,"row_hash"?: string | null,"row_number": number,"theme"?: Json | null,"ticket_id"?: number | null
                  }
                  Update: {
                    "applied_action"?: string | null,"applied_at"?: string | null,"attachments"?: NonNullable<Json>,"error_code"?: string | null,"error_message"?: string | null,"is_valid"?: boolean,"job_id"?: string,"line"?: number | null,"organization_id"?: number | null,"planned_action"?: string | null,"raw"?: Json | null,"record"?: Json | null,"row_hash"?: string | null,"row_number"?: number,"theme"?: Json | null,"ticket_id"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_job_rows_job_id_fkey"
      columns: ["job_id"]
isOneToOne: false
      referencedRelation: "import_jobs"
      referencedColumns: ["id"]
    }
                  ]
                },"import_jobs": {
                  Row: {
                    "archive_cycle_id": string | null,"archive_project_id": string | null,"archive_scope": string | null,"attempts": number,"cancelled_at": string | null,"cancelled_by": string | null,"completed_at": string | null,"confirmed_at": string | null,"confirmed_by": string | null,"created_at": string,"created_by": string | null,"data_as_of": string | null,"declared_size_bytes": number,"error_code": string | null,"file_format": string,"file_hash": string | null,"file_size_bytes": number | null,"heartbeat_at": string | null,"id": string,"import_run_id": string | null,"invalid_row_policy": string | null,"last_error": string | null,"last_kick_at": string | null,"lease_expires_at": string | null,"lease_owner": string | null,"max_attempts": number,"max_created_at": string | null,"min_created_at": string | null,"mode": string,"new_cycle": Json | null,"new_cycle_id": string | null,"new_project": Json | null,"original_filename": string,"preview": Json | null,"preview_computed_at": string | null,"preview_version": number,"progress_done": number,"progress_phase": string | null,"progress_total": number,"project_id": string | null,"rows_applied": number,"rows_invalid": number | null,"rows_staged": number,"rows_to_apply": number | null,"rows_total": number | null,"rows_valid": number | null,"status": string,"storage_path": string,"updated_at": string,"uploaded_at": string | null,"validation_summary": NonNullable<Json>,"warnings_count": number | null
                  }
                  Insert: {
                    "archive_cycle_id"?: string | null,"archive_project_id"?: string | null,"archive_scope"?: string | null,"attempts"?: number,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"completed_at"?: string | null,"confirmed_at"?: string | null,"confirmed_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"data_as_of"?: string | null,"declared_size_bytes": number,"error_code"?: string | null,"file_format": string,"file_hash"?: string | null,"file_size_bytes"?: number | null,"heartbeat_at"?: string | null,"id"?: string,"import_run_id"?: string | null,"invalid_row_policy"?: string | null,"last_error"?: string | null,"last_kick_at"?: string | null,"lease_expires_at"?: string | null,"lease_owner"?: string | null,"max_attempts"?: number,"max_created_at"?: string | null,"min_created_at"?: string | null,"mode": string,"new_cycle"?: Json | null,"new_cycle_id"?: string | null,"new_project"?: Json | null,"original_filename": string,"preview"?: Json | null,"preview_computed_at"?: string | null,"preview_version"?: number,"progress_done"?: number,"progress_phase"?: string | null,"progress_total"?: number,"project_id"?: string | null,"rows_applied"?: number,"rows_invalid"?: number | null,"rows_staged"?: number,"rows_to_apply"?: number | null,"rows_total"?: number | null,"rows_valid"?: number | null,"status"?: string,"storage_path": string,"updated_at"?: string,"uploaded_at"?: string | null,"validation_summary"?: NonNullable<Json>,"warnings_count"?: number | null
                  }
                  Update: {
                    "archive_cycle_id"?: string | null,"archive_project_id"?: string | null,"archive_scope"?: string | null,"attempts"?: number,"cancelled_at"?: string | null,"cancelled_by"?: string | null,"completed_at"?: string | null,"confirmed_at"?: string | null,"confirmed_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"data_as_of"?: string | null,"declared_size_bytes"?: number,"error_code"?: string | null,"file_format"?: string,"file_hash"?: string | null,"file_size_bytes"?: number | null,"heartbeat_at"?: string | null,"id"?: string,"import_run_id"?: string | null,"invalid_row_policy"?: string | null,"last_error"?: string | null,"last_kick_at"?: string | null,"lease_expires_at"?: string | null,"lease_owner"?: string | null,"max_attempts"?: number,"max_created_at"?: string | null,"min_created_at"?: string | null,"mode"?: string,"new_cycle"?: Json | null,"new_cycle_id"?: string | null,"new_project"?: Json | null,"original_filename"?: string,"preview"?: Json | null,"preview_computed_at"?: string | null,"preview_version"?: number,"progress_done"?: number,"progress_phase"?: string | null,"progress_total"?: number,"project_id"?: string | null,"rows_applied"?: number,"rows_invalid"?: number | null,"rows_staged"?: number,"rows_to_apply"?: number | null,"rows_total"?: number | null,"rows_valid"?: number | null,"status"?: string,"storage_path"?: string,"updated_at"?: string,"uploaded_at"?: string | null,"validation_summary"?: NonNullable<Json>,"warnings_count"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_jobs_archive_cycle_id_fkey"
      columns: ["archive_cycle_id"]
isOneToOne: false
      referencedRelation: "reporting_cycles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "import_jobs_archive_project_id_fkey"
      columns: ["archive_project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "import_jobs_import_run_id_fkey"
      columns: ["import_run_id"]
isOneToOne: false
      referencedRelation: "import_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "import_jobs_new_cycle_id_fkey"
      columns: ["new_cycle_id"]
isOneToOne: false
      referencedRelation: "reporting_cycles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "import_jobs_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    }
                  ]
                },"import_runs": {
                  Row: {
                    "completed_at": string | null,"created_at": string,"data_as_of": string | null,"duplicate_of_run_id": string | null,"error_summary": string | null,"file_hash": string,"file_size_bytes": number | null,"id": string,"importer_version": string,"inserted_count": number,"invalid_row_policy": string | null,"max_created_at": string | null,"min_created_at": string | null,"project_id": string | null,"reconciliation": NonNullable<Json>,"records_in_file": number | null,"rejected_count": number,"skipped_count": number | null,"skipped_stale_count": number,"skipped_unchanged_count": number,"source": string,"source_filename": string,"started_at": string,"status": string,"triggered_by": string | null,"update_policy": string,"updated_count": number
                  }
                  Insert: {
                    "completed_at"?: string | null,"created_at"?: string,"data_as_of"?: string | null,"duplicate_of_run_id"?: string | null,"error_summary"?: string | null,"file_hash": string,"file_size_bytes"?: number | null,"id"?: string,"importer_version": string,"inserted_count"?: number,"invalid_row_policy"?: string | null,"max_created_at"?: string | null,"min_created_at"?: string | null,"project_id"?: string | null,"reconciliation"?: NonNullable<Json>,"records_in_file"?: number | null,"rejected_count"?: number,"skipped_count"?: never,"skipped_stale_count"?: number,"skipped_unchanged_count"?: number,"source"?: string,"source_filename": string,"started_at"?: string,"status"?: string,"triggered_by"?: string | null,"update_policy": string,"updated_count"?: number
                  }
                  Update: {
                    "completed_at"?: string | null,"created_at"?: string,"data_as_of"?: string | null,"duplicate_of_run_id"?: string | null,"error_summary"?: string | null,"file_hash"?: string,"file_size_bytes"?: number | null,"id"?: string,"importer_version"?: string,"inserted_count"?: number,"invalid_row_policy"?: string | null,"max_created_at"?: string | null,"min_created_at"?: string | null,"project_id"?: string | null,"reconciliation"?: NonNullable<Json>,"records_in_file"?: number | null,"rejected_count"?: number,"skipped_count"?: never,"skipped_stale_count"?: number,"skipped_unchanged_count"?: number,"source"?: string,"source_filename"?: string,"started_at"?: string,"status"?: string,"triggered_by"?: string | null,"update_policy"?: string,"updated_count"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_runs_duplicate_of_run_id_fkey"
      columns: ["duplicate_of_run_id"]
isOneToOne: false
      referencedRelation: "import_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "import_runs_project_id_fkey"
      columns: ["project_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id"]
    }
                  ]
                },"insight_rules": {
                  Row: {
                    "description": string,"key": string,"label": string,"max_value": number,"min_value": number,"sort_order": number,"unit": string,"updated_at": string,"updated_by": string | null,"value": number
                  }
                  Insert: {
                    "description": string,"key": string,"label": string,"max_value": number,"min_value": number,"sort_order"?: number,"unit": string,"updated_at"?: string,"updated_by"?: string | null,"value": number
                  }
                  Update: {
                    "description"?: string,"key"?: string,"label"?: string,"max_value"?: number,"min_value"?: number,"sort_order"?: number,"unit"?: string,"updated_at"?: string,"updated_by"?: string | null,"value"?: number
                  }
                  Relationships: [
                    
                  ]
                },"projects": {
                  Row: {
                    "archive_reason": string | null,"archived_at": string | null,"archived_by": string | null,"archived_via": string | null,"code": string,"created_at": string,"created_by": string | null,"cycle_id": string,"description": string | null,"display_order": number,"file_name_hint": string,"id": string,"intake": string,"intake_group": string,"name": string,"organization_id": number,"program": string,"status": string,"updated_at": string
                  }
                  Insert: {
                    "archive_reason"?: string | null,"archived_at"?: string | null,"archived_by"?: string | null,"archived_via"?: string | null,"code": string,"created_at"?: string,"created_by"?: string | null,"cycle_id": string,"description"?: string | null,"display_order"?: number,"file_name_hint": string,"id"?: string,"intake": string,"intake_group": string,"name": string,"organization_id": number,"program": string,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "archive_reason"?: string | null,"archived_at"?: string | null,"archived_by"?: string | null,"archived_via"?: string | null,"code"?: string,"created_at"?: string,"created_by"?: string | null,"cycle_id"?: string,"description"?: string | null,"display_order"?: number,"file_name_hint"?: string,"id"?: string,"intake"?: string,"intake_group"?: string,"name"?: string,"organization_id"?: number,"program"?: string,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "projects_cycle_id_fkey"
      columns: ["cycle_id"]
isOneToOne: false
      referencedRelation: "reporting_cycles"
      referencedColumns: ["id"]
    }
                  ]
                },"reporting_cycles": {
                  Row: {
                    "archive_reason": string | null,"archived_at": string | null,"archived_by": string | null,"code": string,"created_at": string,"created_by": string | null,"description": string | null,"display_order": number,"id": string,"is_current": boolean,"name": string,"status": string,"updated_at": string
                  }
                  Insert: {
                    "archive_reason"?: string | null,"archived_at"?: string | null,"archived_by"?: string | null,"code": string,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"display_order"?: number,"id"?: string,"is_current"?: boolean,"name": string,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "archive_reason"?: string | null,"archived_at"?: string | null,"archived_by"?: string | null,"code"?: string,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"display_order"?: number,"id"?: string,"is_current"?: boolean,"name"?: string,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"ticket_attachments": {
                  Row: {
                    "attachment_type": string,"created_at": string,"file_extension": string | null,"file_name": string | null,"id": number,"position": number,"ticket_pk": number,"url": string,"url_host": string | null
                  }
                  Insert: {
                    "attachment_type": string,"created_at"?: string,"file_extension"?: string | null,"file_name"?: string | null,"id"?: never,"position": number,"ticket_pk": number,"url": string,"url_host"?: string | null
                  }
                  Update: {
                    "attachment_type"?: string,"created_at"?: string,"file_extension"?: string | null,"file_name"?: string | null,"id"?: never,"position"?: number,"ticket_pk"?: number,"url"?: string,"url_host"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "ticket_attachments_ticket_pk_fkey"
      columns: ["ticket_pk"]
isOneToOne: false
      referencedRelation: "tickets"
      referencedColumns: ["id"]
    }
                  ]
                },"ticket_categories": {
                  Row: {
                    "code": string,"created_at": string,"description": string | null,"id": number,"is_active": boolean,"kind": string,"name_ar": string | null,"name_en": string,"parent_id": number | null,"sort_order": number,"updated_at": string
                  }
                  Insert: {
                    "code": string,"created_at"?: string,"description"?: string | null,"id"?: never,"is_active"?: boolean,"kind": string,"name_ar"?: string | null,"name_en": string,"parent_id"?: number | null,"sort_order"?: number,"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"description"?: string | null,"id"?: never,"is_active"?: boolean,"kind"?: string,"name_ar"?: string | null,"name_en"?: string,"parent_id"?: number | null,"sort_order"?: number,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ticket_categories_parent_id_fkey"
      columns: ["parent_id"]
isOneToOne: false
      referencedRelation: "ticket_categories"
      referencedColumns: ["id"]
    }
                  ]
                },"ticket_changes": {
                  Row: {
                    "changed_at": string,"changes": NonNullable<Json>,"id": number,"import_run_id": string | null,"new_row_hash": string,"new_source_data_as_of": string | null,"previous_row_hash": string,"previous_source_data_as_of": string | null,"ticket_pk": number
                  }
                  Insert: {
                    "changed_at"?: string,"changes": NonNullable<Json>,"id"?: never,"import_run_id"?: string | null,"new_row_hash": string,"new_source_data_as_of"?: string | null,"previous_row_hash": string,"previous_source_data_as_of"?: string | null,"ticket_pk": number
                  }
                  Update: {
                    "changed_at"?: string,"changes"?: NonNullable<Json>,"id"?: never,"import_run_id"?: string | null,"new_row_hash"?: string,"new_source_data_as_of"?: string | null,"previous_row_hash"?: string,"previous_source_data_as_of"?: string | null,"ticket_pk"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "ticket_changes_import_run_id_fkey"
      columns: ["import_run_id"]
isOneToOne: false
      referencedRelation: "import_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ticket_changes_ticket_pk_fkey"
      columns: ["ticket_pk"]
isOneToOne: false
      referencedRelation: "tickets"
      referencedColumns: ["id"]
    }
                  ]
                },"ticket_classifications": {
                  Row: {
                    "category_id": number,"confidence": number | null,"created_at": string,"evidence": NonNullable<Json>,"id": number,"is_current": boolean,"method": string,"subcategory_id": number | null,"ticket_pk": number,"version": string
                  }
                  Insert: {
                    "category_id": number,"confidence"?: number | null,"created_at"?: string,"evidence"?: NonNullable<Json>,"id"?: never,"is_current"?: boolean,"method": string,"subcategory_id"?: number | null,"ticket_pk": number,"version": string
                  }
                  Update: {
                    "category_id"?: number,"confidence"?: number | null,"created_at"?: string,"evidence"?: NonNullable<Json>,"id"?: never,"is_current"?: boolean,"method"?: string,"subcategory_id"?: number | null,"ticket_pk"?: number,"version"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ticket_classifications_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "ticket_categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ticket_classifications_subcategory_id_fkey"
      columns: ["subcategory_id"]
isOneToOne: false
      referencedRelation: "ticket_categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ticket_classifications_ticket_pk_fkey"
      columns: ["ticket_pk"]
isOneToOne: false
      referencedRelation: "tickets"
      referencedColumns: ["id"]
    }
                  ]
                },"ticket_statuses": {
                  Row: {
                    "label": string,"sort_order": number,"status": string,"status_class": string,"updated_at": string,"updated_by": string | null
                  }
                  Insert: {
                    "label": string,"sort_order"?: number,"status": string,"status_class": string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "label"?: string,"sort_order"?: number,"status"?: string,"status_class"?: string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"tickets": {
                  Row: {
                    "affected_student_id": string | null,"attachment_urls": string | null,"created_at": string,"created_date": string | null,"created_hour": number | null,"created_isodow": number | null,"department": string | null,"first_import_run_id": string,"id": number,"imported_at": string,"last_import_run_id": string,"lesson_name": string | null,"message": string | null,"message_language": string | null,"note": string | null,"organization_id": number,"owner_id": string | null,"owner_type": string | null,"parser_version": string | null,"priority": string | null,"project_id": string,"resolution_seconds": number | null,"resolved_at": string | null,"resolved_by": string | null,"responded_at": string | null,"responder_name": string | null,"response": string | null,"response_attachment_urls": string | null,"response_kind": string,"response_seconds": number | null,"row_hash": string,"session_ref": string | null,"source_data_as_of": string,"source_filename": string,"source_row_number": number,"status": string | null,"sub_topic": string | null,"ticket_id": number,"topic": string,"updated_at": string
                  }
                  Insert: {
                    "affected_student_id"?: string | null,"attachment_urls"?: string | null,"created_at": string,"created_date"?: never,"created_hour"?: never,"created_isodow"?: never,"department"?: string | null,"first_import_run_id": string,"id"?: never,"imported_at"?: string,"last_import_run_id": string,"lesson_name"?: string | null,"message"?: string | null,"message_language"?: string | null,"note"?: string | null,"organization_id": number,"owner_id"?: string | null,"owner_type"?: string | null,"parser_version"?: string | null,"priority"?: string | null,"project_id": string,"resolution_seconds"?: never,"resolved_at"?: string | null,"resolved_by"?: string | null,"responded_at"?: string | null,"responder_name"?: string | null,"response"?: string | null,"response_attachment_urls"?: string | null,"response_kind"?: string,"response_seconds"?: never,"row_hash": string,"session_ref"?: string | null,"source_data_as_of": string,"source_filename": string,"source_row_number": number,"status"?: string | null,"sub_topic"?: string | null,"ticket_id": number,"topic": string,"updated_at"?: string
                  }
                  Update: {
                    "affected_student_id"?: string | null,"attachment_urls"?: string | null,"created_at"?: string,"created_date"?: never,"created_hour"?: never,"created_isodow"?: never,"department"?: string | null,"first_import_run_id"?: string,"id"?: never,"imported_at"?: string,"last_import_run_id"?: string,"lesson_name"?: string | null,"message"?: string | null,"message_language"?: string | null,"note"?: string | null,"organization_id"?: number,"owner_id"?: string | null,"owner_type"?: string | null,"parser_version"?: string | null,"priority"?: string | null,"project_id"?: string,"resolution_seconds"?: never,"resolved_at"?: string | null,"resolved_by"?: string | null,"responded_at"?: string | null,"responder_name"?: string | null,"response"?: string | null,"response_attachment_urls"?: string | null,"response_kind"?: string,"response_seconds"?: never,"row_hash"?: string,"session_ref"?: string | null,"source_data_as_of"?: string,"source_filename"?: string,"source_row_number"?: number,"status"?: string | null,"sub_topic"?: string | null,"ticket_id"?: number,"topic"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tickets_first_import_run_id_fkey"
      columns: ["first_import_run_id"]
isOneToOne: false
      referencedRelation: "import_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tickets_last_import_run_id_fkey"
      columns: ["last_import_run_id"]
isOneToOne: false
      referencedRelation: "import_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tickets_project_org_fk"
      columns: ["project_id","organization_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id","organization_id"]
    }
                  ]
                },"topic_categories": {
                  Row: {
                    "category_id": number,"source": string,"topic": string,"updated_at": string,"updated_by": string | null
                  }
                  Insert: {
                    "category_id": number,"source"?: string,"topic": string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "category_id"?: number,"source"?: string,"topic"?: string,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "topic_categories_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "ticket_categories"
      referencedColumns: ["id"]
    }
                  ]
                },"user_roles": {
                  Row: {
                    "created_at": string,"granted_by": string | null,"role": string,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"granted_by"?: string | null,"role": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"granted_by"?: string | null,"role"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "archive_cycle":
{ Args: { "p_code": string,"p_confirm": string,"p_new_current"?: string,"p_reason": string }; Returns: Json
                           },
"archive_project":
{ Args: { "p_code": string,"p_confirm": string,"p_reason": string }; Returns: Json
                           },
"cancel_import_job":
{ Args: { "p_job_id": string }; Returns: Json
                           },
"confirm_import_job":
{ Args: { "p_job_id": string,"p_policy": string,"p_preview_version": number }; Returns: Json
                           },
"create_import_job":
{ Args: { "p_spec": Json }; Returns: Json
                           },
"create_project":
{ Args: { "p_cycle"?: string,"p_project": Json }; Returns: Json
                           },
"create_reporting_cycle":
{ Args: { "p_cycle": Json,"p_make_current"?: boolean }; Returns: Json
                           },
"export_tickets_page":
{ Args: { "p_after_pk"?: number,"p_filters"?: Json,"p_include_text"?: boolean,"p_limit"?: number }; Returns: Json
                           },
"get_audit_events":
{ Args: { "p_limit"?: number }; Returns: Json
                           },
"get_backlog":
{ Args: { "p_filters"?: Json,"p_oldest_limit"?: number }; Returns: Json
                           },
"get_cross_tab":
{ Args: { "p_col_dimension"?: string,"p_filters"?: Json,"p_row_dimension"?: string }; Returns: Json
                           },
"get_data_quality":
{ Args: { "p_filters"?: Json }; Returns: Json
                           },
"get_duration_histogram":
{ Args: { "p_filters"?: Json,"p_metric"?: string,"p_split"?: string }; Returns: Json
                           },
"get_filter_options":
{ Args: { "p_scope"?: Json }; Returns: Json
                           },
"get_grouped_metrics":
{ Args: { "p_dimension"?: string,"p_filters"?: Json,"p_limit"?: number }; Returns: Json
                           },
"get_import_job":
{ Args: { "p_job_id": string }; Returns: Json
                           },
"get_import_job_issues":
{ Args: { "p_job_id": string,"p_limit"?: number,"p_offset"?: number,"p_severity"?: string }; Returns: Json
                           },
"get_import_jobs":
{ Args: { "p_limit"?: number }; Returns: Json
                           },
"get_import_run_detail":
{ Args: { "p_run_id": string }; Returns: Json
                           },
"get_import_runs":
{ Args: { "p_limit"?: number }; Returns: Json
                           },
"get_my_access":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"get_period_comparison":
{ Args: { "p_days"?: number,"p_dimension"?: string,"p_filters"?: Json }; Returns: Json
                           },
"get_project_history":
{ Args: { "p_code": string }; Returns: Json
                           },
"get_recurring_sessions":
{ Args: { "p_filters"?: Json,"p_limit"?: number,"p_min_students"?: number }; Returns: Json
                           },
"get_scope_catalog":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"get_settings":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"get_status_values":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"get_ticket_detail":
{ Args: { "p_project_code"?: string,"p_ticket_id": number }; Returns: Json
                           },
"get_topic_mappings":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"get_volume_series":
{ Args: { "p_filters"?: Json,"p_grain"?: string,"p_split"?: string }; Returns: Json
                           },
"get_weekday_hour":
{ Args: { "p_filters"?: Json }; Returns: Json
                           },
"list_app_users":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"mark_import_uploaded":
{ Args: { "p_job_id": string }; Returns: Json
                           },
"record_export":
{ Args: { "p_filters": Json,"p_kind": string,"p_row_count": number }; Returns: undefined
                           },
"refresh_import_preview":
{ Args: { "p_job_id": string }; Returns: Json
                           },
"restore_cycle":
{ Args: { "p_code": string,"p_make_current"?: boolean }; Returns: Json
                           },
"restore_project":
{ Args: { "p_code": string }; Returns: Json
                           },
"retry_import_job":
{ Args: { "p_job_id": string }; Returns: Json
                           },
"revoke_user_role":
{ Args: { "p_user_id": string }; Returns: Json
                           },
"search_tickets":
{ Args: { "p_dir"?: string,"p_filters"?: Json,"p_page"?: number,"p_page_size"?: number,"p_search"?: string,"p_sort"?: string }; Returns: Json
                           },
"set_current_cycle":
{ Args: { "p_code": string }; Returns: Json
                           },
"set_status_class":
{ Args: { "p_class": string,"p_label"?: string,"p_status": string }; Returns: Json
                           },
"set_topic_category":
{ Args: { "p_category_code": string,"p_topic": string }; Returns: Json
                           },
"set_user_role":
{ Args: { "p_email": string,"p_role": string }; Returns: Json
                           },
"update_app_setting":
{ Args: { "p_key": string,"p_value": Json }; Returns: Json
                           },
"update_insight_rule":
{ Args: { "p_key": string,"p_value": number }; Returns: Json
                           },
"update_project":
{ Args: { "p_code": string,"p_project": Json }; Returns: Json
                           },
"update_reporting_cycle":
{ Args: { "p_code": string,"p_description"?: string,"p_name": string }; Returns: Json
                           },
"update_threshold":
{ Args: { "p_key": string,"p_value_hours": number }; Returns: Json
                           },
"upsert_category":
{ Args: { "p_code": string,"p_description"?: string,"p_is_active"?: boolean,"p_name_ar"?: string,"p_name_en": string }; Returns: Json
                           },
"worker_apply_batch":
{ Args: { "p_batch_size"?: number,"p_job_id": string,"p_worker": string }; Returns: Json
                           },
"worker_claim_job":
{ Args: { "p_job_id"?: string,"p_lease_seconds"?: number,"p_worker": string }; Returns: Json
                           },
"worker_fail":
{ Args: { "p_job_id": string,"p_message": string,"p_retryable"?: boolean,"p_worker": string }; Returns: string
                           },
"worker_finish_validation":
{ Args: { "p_file_issues"?: Json,"p_job_id": string,"p_summary": Json,"p_worker": string }; Returns: Json
                           },
"worker_heartbeat":
{ Args: { "p_done": number,"p_job_id": string,"p_phase": string,"p_total": number,"p_worker": string }; Returns: boolean
                           },
"worker_set_file":
{ Args: { "p_hash": string,"p_job_id": string,"p_rows_total": number,"p_size": number,"p_worker": string }; Returns: boolean
                           },
"worker_stage_rows":
{ Args: { "p_issues"?: Json,"p_job_id": string,"p_rows": Json,"p_worker": string }; Returns: number
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            
          }
        }
} as const

