
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
                },"import_runs": {
                  Row: {
                    "completed_at": string | null,"created_at": string,"data_as_of": string | null,"duplicate_of_run_id": string | null,"error_summary": string | null,"file_hash": string,"file_size_bytes": number | null,"id": string,"importer_version": string,"inserted_count": number,"max_created_at": string | null,"min_created_at": string | null,"project_id": string | null,"reconciliation": NonNullable<Json>,"records_in_file": number | null,"rejected_count": number,"skipped_count": number | null,"skipped_stale_count": number,"skipped_unchanged_count": number,"source_filename": string,"started_at": string,"status": string,"update_policy": string,"updated_count": number
                  }
                  Insert: {
                    "completed_at"?: string | null,"created_at"?: string,"data_as_of"?: string | null,"duplicate_of_run_id"?: string | null,"error_summary"?: string | null,"file_hash": string,"file_size_bytes"?: number | null,"id"?: string,"importer_version": string,"inserted_count"?: number,"max_created_at"?: string | null,"min_created_at"?: string | null,"project_id"?: string | null,"reconciliation"?: NonNullable<Json>,"records_in_file"?: number | null,"rejected_count"?: number,"skipped_count"?: never,"skipped_stale_count"?: number,"skipped_unchanged_count"?: number,"source_filename": string,"started_at"?: string,"status"?: string,"update_policy": string,"updated_count"?: number
                  }
                  Update: {
                    "completed_at"?: string | null,"created_at"?: string,"data_as_of"?: string | null,"duplicate_of_run_id"?: string | null,"error_summary"?: string | null,"file_hash"?: string,"file_size_bytes"?: number | null,"id"?: string,"importer_version"?: string,"inserted_count"?: number,"max_created_at"?: string | null,"min_created_at"?: string | null,"project_id"?: string | null,"reconciliation"?: NonNullable<Json>,"records_in_file"?: number | null,"rejected_count"?: number,"skipped_count"?: never,"skipped_stale_count"?: number,"skipped_unchanged_count"?: number,"source_filename"?: string,"started_at"?: string,"status"?: string,"update_policy"?: string,"updated_count"?: number
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
                },"projects": {
                  Row: {
                    "code": string,"created_at": string,"display_order": number,"file_name_hint": string,"id": string,"intake": string,"intake_group": string,"is_active": boolean,"name": string,"organization_id": number,"program": string,"updated_at": string
                  }
                  Insert: {
                    "code": string,"created_at"?: string,"display_order"?: number,"file_name_hint": string,"id"?: string,"intake": string,"intake_group": string,"is_active"?: boolean,"name": string,"organization_id": number,"program": string,"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"display_order"?: number,"file_name_hint"?: string,"id"?: string,"intake"?: string,"intake_group"?: string,"is_active"?: boolean,"name"?: string,"organization_id"?: number,"program"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"ticket_attachments": {
                  Row: {
                    "attachment_type": string,"created_at": string,"file_extension": string | null,"file_name": string | null,"id": number,"position": number,"ticket_id": number,"url": string,"url_host": string | null
                  }
                  Insert: {
                    "attachment_type": string,"created_at"?: string,"file_extension"?: string | null,"file_name"?: string | null,"id"?: never,"position": number,"ticket_id": number,"url": string,"url_host"?: string | null
                  }
                  Update: {
                    "attachment_type"?: string,"created_at"?: string,"file_extension"?: string | null,"file_name"?: string | null,"id"?: never,"position"?: number,"ticket_id"?: number,"url"?: string,"url_host"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "ticket_attachments_ticket_id_fkey"
      columns: ["ticket_id"]
isOneToOne: false
      referencedRelation: "tickets"
      referencedColumns: ["ticket_id"]
    }
                  ]
                },"ticket_categories": {
                  Row: {
                    "code": string,"created_at": string,"description": string | null,"id": number,"is_active": boolean,"kind": string,"name_ar": string | null,"name_en": string,"parent_id": number | null,"sort_order": number,"source_topics": (string)[],"updated_at": string
                  }
                  Insert: {
                    "code": string,"created_at"?: string,"description"?: string | null,"id"?: never,"is_active"?: boolean,"kind": string,"name_ar"?: string | null,"name_en": string,"parent_id"?: number | null,"sort_order"?: number,"source_topics"?: (string)[],"updated_at"?: string
                  }
                  Update: {
                    "code"?: string,"created_at"?: string,"description"?: string | null,"id"?: never,"is_active"?: boolean,"kind"?: string,"name_ar"?: string | null,"name_en"?: string,"parent_id"?: number | null,"sort_order"?: number,"source_topics"?: (string)[],"updated_at"?: string
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
                },"ticket_classifications": {
                  Row: {
                    "category_id": number,"confidence": number | null,"created_at": string,"evidence": NonNullable<Json>,"id": number,"is_current": boolean,"method": string,"subcategory_id": number | null,"ticket_id": number,"version": string
                  }
                  Insert: {
                    "category_id": number,"confidence"?: number | null,"created_at"?: string,"evidence"?: NonNullable<Json>,"id"?: never,"is_current"?: boolean,"method": string,"subcategory_id"?: number | null,"ticket_id": number,"version": string
                  }
                  Update: {
                    "category_id"?: number,"confidence"?: number | null,"created_at"?: string,"evidence"?: NonNullable<Json>,"id"?: never,"is_current"?: boolean,"method"?: string,"subcategory_id"?: number | null,"ticket_id"?: number,"version"?: string
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
      foreignKeyName: "ticket_classifications_ticket_id_fkey"
      columns: ["ticket_id"]
isOneToOne: false
      referencedRelation: "tickets"
      referencedColumns: ["ticket_id"]
    }
                  ]
                },"tickets": {
                  Row: {
                    "affected_student_id": string | null,"attachment_urls": string | null,"created_at": string,"created_date": string | null,"created_hour": number | null,"created_isodow": number | null,"department": string | null,"first_import_run_id": string,"imported_at": string,"last_import_run_id": string,"lesson_name": string | null,"message": string | null,"message_language": string | null,"note": string | null,"organization_id": number,"owner_id": string | null,"owner_type": string | null,"parser_version": string | null,"priority": string | null,"project_id": string,"resolution_seconds": number | null,"resolved_at": string | null,"resolved_by": string | null,"responded_at": string | null,"responder_name": string | null,"response": string | null,"response_attachment_urls": string | null,"response_kind": string,"response_seconds": number | null,"row_hash": string,"session_ref": string | null,"source_data_as_of": string,"source_filename": string,"source_row_number": number,"status": string | null,"sub_topic": string | null,"ticket_id": number,"topic": string,"updated_at": string
                  }
                  Insert: {
                    "affected_student_id"?: string | null,"attachment_urls"?: string | null,"created_at": string,"created_date"?: never,"created_hour"?: never,"created_isodow"?: never,"department"?: string | null,"first_import_run_id": string,"imported_at"?: string,"last_import_run_id": string,"lesson_name"?: string | null,"message"?: string | null,"message_language"?: string | null,"note"?: string | null,"organization_id": number,"owner_id"?: string | null,"owner_type"?: string | null,"parser_version"?: string | null,"priority"?: string | null,"project_id": string,"resolution_seconds"?: never,"resolved_at"?: string | null,"resolved_by"?: string | null,"responded_at"?: string | null,"responder_name"?: string | null,"response"?: string | null,"response_attachment_urls"?: string | null,"response_kind"?: string,"response_seconds"?: never,"row_hash": string,"session_ref"?: string | null,"source_data_as_of": string,"source_filename": string,"source_row_number": number,"status"?: string | null,"sub_topic"?: string | null,"ticket_id": number,"topic": string,"updated_at"?: string
                  }
                  Update: {
                    "affected_student_id"?: string | null,"attachment_urls"?: string | null,"created_at"?: string,"created_date"?: never,"created_hour"?: never,"created_isodow"?: never,"department"?: string | null,"first_import_run_id"?: string,"imported_at"?: string,"last_import_run_id"?: string,"lesson_name"?: string | null,"message"?: string | null,"message_language"?: string | null,"note"?: string | null,"organization_id"?: number,"owner_id"?: string | null,"owner_type"?: string | null,"parser_version"?: string | null,"priority"?: string | null,"project_id"?: string,"resolution_seconds"?: never,"resolved_at"?: string | null,"resolved_by"?: string | null,"responded_at"?: string | null,"responder_name"?: string | null,"response"?: string | null,"response_attachment_urls"?: string | null,"response_kind"?: string,"response_seconds"?: never,"row_hash"?: string,"session_ref"?: string | null,"source_data_as_of"?: string,"source_filename"?: string,"source_row_number"?: number,"status"?: string | null,"sub_topic"?: string | null,"ticket_id"?: number,"topic"?: string,"updated_at"?: string
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
            "export_tickets_page":
{ Args: { "p_after_ticket_id"?: number,"p_filters"?: Json,"p_include_text"?: boolean,"p_limit"?: number }; Returns: Json
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
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"get_grouped_metrics":
{ Args: { "p_dimension"?: string,"p_filters"?: Json,"p_limit"?: number }; Returns: Json
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
"get_recurring_sessions":
{ Args: { "p_filters"?: Json,"p_limit"?: number,"p_min_students"?: number }; Returns: Json
                           },
"get_settings":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"get_ticket_detail":
{ Args: { "p_ticket_id": number }; Returns: Json
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
"record_export":
{ Args: { "p_filters": Json,"p_kind": string,"p_row_count": number }; Returns: undefined
                           },
"revoke_user_role":
{ Args: { "p_user_id": string }; Returns: Json
                           },
"search_tickets":
{ Args: { "p_dir"?: string,"p_filters"?: Json,"p_page"?: number,"p_page_size"?: number,"p_search"?: string,"p_sort"?: string }; Returns: Json
                           },
"set_user_role":
{ Args: { "p_email": string,"p_role": string }; Returns: Json
                           },
"update_app_setting":
{ Args: { "p_key": string,"p_value": Json }; Returns: Json
                           },
"update_project":
{ Args: { "p_code": string,"p_display_order": number,"p_file_name_hint": string,"p_is_active": boolean,"p_name": string }; Returns: Json
                           },
"update_threshold":
{ Args: { "p_key": string,"p_value_hours": number }; Returns: Json
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

