-- =============================================================================
-- CS Tickets Analytics — reference data required in every environment
-- =============================================================================

insert into public.projects
  (code, name, program, intake, intake_group, organization_id, file_name_hint, display_order)
values
  ('DECI_4TH',    'DECI — 4th Intake',    'DECI', '4th Intake',    'Regular', 1610, 'DECI 4th Intake',    1),
  ('DECI_SUMMER', 'DECI — Summer Intake', 'DECI', 'Summer Intake', 'Summer',  1906, 'DECI Summer Intake', 2),
  ('DEMI_3RD',    'DEMI — 3rd Intake',    'DEMI', '3rd Intake',    'Regular', 1609, 'DEMI 3rd Intake',    3),
  ('DEMI_SUMMER', 'DEMI — Summer Intake', 'DEMI', 'Summer Intake', 'Summer',  1939, 'DEMI Summer Intake', 4)
on conflict (code) do nothing;

-- Categories group the source `Topic` values. They are an analytical lens, not
-- a verified root cause; the original Topic is always preserved on tickets.
insert into public.ticket_categories (code, kind, name_en, name_ar, description, source_topics, sort_order)
values
  ('session_feedback', 'category', 'Session evaluation & feedback', 'تقييم الجلسات والتعليقات',
   'Requests about missing evaluations or comments after a session.',
   array['No Evaluation or Comment After Session'], 1),
  ('session_delivery', 'category', 'Session delivery & quality', 'تقديم الجلسات وجودتها',
   'Timing, technical and explanation-quality problems during sessions.',
   array['Session Started Late or Ended Early', 'Problem During Virtual Session',
         'Session Quality Issue (Explanation and Communication)'], 2),
  ('tutor_conduct', 'category', 'Tutor conduct & responsiveness', 'سلوك المدرب واستجابته',
   'Tutor behaviour during sessions and responsiveness in the student community.',
   array['Tutor Behavior Issue During Session', 'Tutor Delayed Response in Student Community'], 3),
  ('attendance_appeals', 'category', 'Attendance appeals', 'تظلمات الغياب',
   'Appeals against recorded absences in virtual or practical sessions.',
   array['Virtual Session Absence Appeal', 'Practical Session Absence Appeal'], 4),
  ('scheduling_account', 'category', 'Scheduling & account changes', 'تغيير المواعيد والبيانات',
   'Requests to change session time, area, day, or student information.',
   array['Change Virtual Session Time', 'Change Practical Session Area',
         'Change Practical Session Day and Time', 'Change Student Information'], 5),
  ('general_inquiry', 'category', 'General problem / inquiry', 'مشكلة أو استفسار عام',
   'The broad "Report a Problem / inquiry" topic.',
   array['Report a Problem / inquiry'], 6),
  ('uncategorized', 'category', 'Uncategorized topic', 'موضوع غير مصنف',
   'Fallback for source topics not yet mapped to a category.', '{}', 99)
on conflict (code) do nothing;

-- Subcategories are cross-cutting issue themes detected from the free-text
-- details of a message by deterministic keyword rules (see src/lib/classification).
insert into public.ticket_categories (code, kind, name_en, name_ar, description, sort_order)
values
  ('attendance_records',   'subcategory', 'Attendance / absence records', 'الحضور والغياب', 'Mentions of absences or attendance records.', 1),
  ('grades_evaluation',    'subcategory', 'Grades, evaluation & comments', 'الدرجات والتقييم', 'Mentions of grades, scores, evaluations or comments.', 2),
  ('platform_access',      'subcategory', 'Platform access & technical errors', 'الدخول للمنصة والأعطال', 'Login, account, app or platform errors.', 3),
  ('session_joining',      'subcategory', 'Joining a session / links', 'الانضمام للجلسة والروابط', 'Problems joining a session or with session links.', 4),
  ('projects_assignments', 'subcategory', 'Projects, tasks & submissions', 'المشاريع والمهام والتسليم', 'Final projects, tasks, assignments and submissions.', 5),
  ('quizzes_exams',        'subcategory', 'Quizzes & exams', 'الاختبارات', 'Quizzes, exams and tests.', 6),
  ('certificates',         'subcategory', 'Certificates', 'الشهادات', 'Certificate requests or problems.', 7),
  ('connectivity_media',   'subcategory', 'Connectivity, audio & video', 'الاتصال والصوت والصورة', 'Internet, audio, microphone, camera or video issues.', 8),
  ('tutor_availability',   'subcategory', 'Tutor absence or lateness', 'غياب أو تأخر المدرب', 'Tutor not present, late, or leaving early.', 9),
  ('schedule_group',       'subcategory', 'Schedule & group changes', 'المواعيد وتغيير المجموعة', 'Session times, schedules and group changes.', 10),
  ('community_channels',   'subcategory', 'Community & communication channels', 'المجتمع وقنوات التواصل', 'Student community, WhatsApp/Telegram groups, replies.', 11),
  ('explanation_quality',  'subcategory', 'Explanation & content quality', 'جودة الشرح والمحتوى', 'Clarity of explanation and content.', 12),
  ('venue_logistics',      'subcategory', 'Venue, devices & logistics', 'المكان والأجهزة والتجهيزات', 'Physical venue, labs, devices, meals.', 13),
  ('no_free_text',         'subcategory', 'Structured request (no free text)', 'طلب منظم بدون تفاصيل', 'The message only contains structured session fields.', 90),
  ('unmatched',            'subcategory', 'Other / unmatched text', 'أخرى / غير مطابق', 'Free text present but no rule matched.', 99)
on conflict (code) do nothing;

insert into public.analytics_thresholds (key, value_hours, label, description)
values
  ('response_hours', 24, 'Recorded first response threshold',
   'A ticket breaches this threshold when (responded_at - created_at) exceeds the value. Illustrative monitoring threshold, not a contractual SLA.'),
  ('resolution_hours', 72, 'Resolution threshold',
   'A ticket breaches this threshold when (resolved_at - created_at) exceeds the value, or when it is still unresolved and older than the value at the export snapshot. Illustrative, not a contractual SLA.')
on conflict (key) do nothing;

insert into public.app_settings (key, value)
values
  ('date_preset_anchor', '"dataset_end"'::jsonb),
  ('default_date_preset', '"all"'::jsonb),
  ('organization_name', '"iSchool"'::jsonb)
on conflict (key) do nothing;
