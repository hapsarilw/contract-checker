// ClauseCheck test fixtures.
// Every flagged clause is defined ONCE here and referenced by both the document
// builder and the answer key, so expected.json excerpts always match the text
// that actually ships in the .docx / .pdf. Excerpt verification (FR-3.3) is a
// verbatim substring check, so drift between the two would silently break TR-3.

export const C = {
  // ---- 01 hostile design services ----
  h_revisions: 'Contractor shall provide revisions until Client is fully satisfied with the deliverables.',
  h_ip: 'All work product, including preliminary concepts, sketches, and materials created by Contractor prior to the Effective Date, shall become the sole and exclusive property of Client upon creation.',
  h_indemnity: 'Contractor shall indemnify, defend, and hold harmless Client against any and all claims, damages, and expenses of any kind whatsoever arising from the Services, without limitation as to amount.',
  h_noncompete: 'For a period of twenty-four (24) months following termination, Contractor shall not provide design services to any business operating in the Client\u2019s industry.',
  h_termination: 'Client may terminate this Agreement at any time, for any reason or no reason, upon written notice, and shall have no obligation to pay for work in progress.',
  h_payment: 'Payment shall be due within ninety (90) days of Client\u2019s acceptance of the final deliverables.',
  h_expenses: 'Contractor shall bear all costs of software, fonts, stock imagery, and other materials required to perform the Services.',

  // ---- 02 moderate dev retainer ----
  m_net60: 'Client shall pay all undisputed invoices within sixty (60) days of receipt.',
  m_termination: 'Either party may terminate this Agreement upon thirty (30) days written notice. Client shall pay for hours worked through the effective date of termination.',
  m_confidentiality: 'Developer shall not disclose the existence of this engagement, the identity of Client, or the nature of the Services to any third party without Client\u2019s prior written consent.',
  m_scope: 'Developer shall address bug reports submitted by Client relating to the Services for a period of six (6) months following delivery at no additional charge.',
  m_rate: 'The hourly rate may be adjusted by Client upon sixty (60) days written notice to Developer.',

  // ---- 04 mixed video production ----
  v_ip: 'Client shall own all right, title, and interest in the final edited video upon full payment of all amounts due under this Agreement.',
  v_revisions: 'The fee includes two (2) rounds of revisions. Additional rounds shall be billed at Producer\u2019s standard hourly rate of $95 per hour.',
  v_reshoot: 'In the event Client requests reshooting of any footage for reasons other than technical defect, Producer shall reshoot at no additional charge.',
  v_late: 'Producer shall pay Client a penalty of five percent (5%) of the total fee for each day of delay in delivery beyond the agreed date.',
  v_portfolio: 'Producer may not display, reproduce, or reference the work in any portfolio, showreel, or promotional material.',
  v_payment: 'Fifty percent (50%) of the total fee is due upon execution of this Agreement, with the balance due within thirty (30) days of final delivery.',
};

// Shared boilerplate — deliberately unremarkable, so a good analyzer leaves it alone.
const boiler = (a, b) => [
  ['h', 'Client Responsibilities'],
  ['p', `${b} shall provide ${a} with all information, assets, approvals, and access reasonably required to perform the Services, within the timeframes agreed between the parties. ${b} shall designate a single point of contact authorised to give feedback and approvals on its behalf. Where ${b} fails to provide required materials or approvals within five (5) business days of a written request, the delivery schedule shall be extended by an equivalent period.`],
  ['h', 'Independent Contractor Status'],
  ['p', `${a} is an independent contractor and not an employee, partner, or agent of ${b}. ${a} is responsible for all taxes, insurance, and statutory contributions arising from payments under this Agreement. Nothing in this Agreement creates an employment relationship between the parties, and ${a} shall have no authority to bind ${b} to any obligation.`],
  ['p', `${a} shall determine the method, details, and means of performing the Services, and may perform them at such times and locations as ${a} considers appropriate, provided that agreed deadlines and any scheduled meetings or attendances are met.`],
  ['h', 'Subcontracting and Assignment'],
  ['p', `${a} shall not subcontract any material part of the Services without ${b}'s prior written consent. Where consent is given, ${a} remains responsible for the acts and omissions of any subcontractor. Neither party may assign this Agreement without the written consent of the other, such consent not to be unreasonably withheld.`],
  ['h', 'Force Majeure'],
  ['p', 'Neither party shall be liable for any failure or delay in performance caused by events beyond its reasonable control, including natural disaster, serious illness, war, civil unrest, epidemic, governmental action, or failure of public infrastructure or communications networks. The affected party shall notify the other promptly and shall use reasonable efforts to resume performance.'],
  ['h', 'Waiver'],
  ['p', 'No failure or delay by either party in exercising any right under this Agreement constitutes a waiver of that right, and no single or partial exercise of any right prevents any further exercise of it or of any other right. A waiver is effective only if given in writing.'],
  ['h', 'Entire Agreement'],
  ['p', 'This Agreement constitutes the entire agreement between the parties with respect to its subject matter and supersedes all prior discussions, proposals, and understandings, whether written or oral. Any amendment must be in writing and signed by both parties.'],
  ['h', 'Severability'],
  ['p', 'If any provision of this Agreement is held to be unenforceable, that provision shall be modified to the minimum extent necessary to make it enforceable, and the remaining provisions shall continue in full force and effect.'],
  ['h', 'Notices'],
  ['p', 'All notices under this Agreement shall be given in writing by email to the addresses set out above, and shall be deemed received on the next business day following transmission.'],
  ['h', 'Signatures'],
  ['p', 'IN WITNESS WHEREOF, the parties have executed this Agreement as of the Effective Date first written above.'],
  ['p', '_______________________________          _______________________________'],
  ['p', `${b}                                                    ${a}`],
];

export const contracts = {

  // ==================================================================
  '01-design-services-hostile': {
    title: 'DESIGN SERVICES AGREEMENT',
    body: [
      ['p', 'This Design Services Agreement (the "Agreement") is entered into as of 12 March 2026 (the "Effective Date") by and between Northgate Retail Group, Inc., a Delaware corporation with offices at 400 Commerce Way, Wilmington, DE ("Client"), and the undersigned individual designer ("Contractor").'],
      ['h', '1. Services'],
      ['p', 'Contractor shall provide brand identity design services, including logo design, colour and typography systems, and application of the identity across packaging and signage templates, as further described in Schedule A (the "Services"). Contractor shall perform the Services in a professional and workmanlike manner consistent with prevailing industry standards.'],
      ['h', '2. Deliverables and Revisions'],
      ['p', 'Contractor shall deliver initial concepts within fourteen (14) days of the Effective Date. ' + C.h_revisions + ' Client shall be the sole judge of whether the deliverables meet the standard of satisfaction required under this Section.'],
      ['p', 'Client may request changes to the scope, direction, or specification of the Services at any time. Contractor shall accommodate such changes within the original fee unless the parties agree otherwise in writing.'],
      ['h', '3. Intellectual Property'],
      ['p', C.h_ip + ' Contractor hereby assigns to Client all copyright, trademark, and other intellectual property rights in such work product, and waives any moral rights therein to the fullest extent permitted by law.'],
      ['p', 'Contractor shall execute any further documents reasonably requested by Client to perfect the assignment described in this Section.'],
      ['h', '4. Fees and Payment'],
      ['p', 'Client shall pay Contractor a fixed fee of eight thousand dollars ($8,000) for the Services. ' + C.h_payment],
      ['p', C.h_expenses + ' No expenses shall be reimbursed unless approved in advance in writing by Client.'],
      ['h', '5. Term and Termination'],
      ['p', C.h_termination + ' Upon termination, Contractor shall immediately deliver to Client all work product, whether complete or incomplete.'],
      ['h', '6. Indemnification'],
      ['p', C.h_indemnity + ' This obligation shall survive the termination of this Agreement.'],
      ['h', '7. Restrictive Covenant'],
      ['p', C.h_noncompete + ' Contractor acknowledges that this restriction is reasonable and necessary to protect Client\u2019s legitimate business interests.'],
      ['h', '8. Confidentiality'],
      ['p', 'Contractor shall keep confidential all non-public information disclosed by Client in connection with the Services, and shall not use such information for any purpose other than performance of the Services. This obligation survives for three (3) years following termination.'],
      ['h', '9. Governing Law'],
      ['p', 'This Agreement shall be governed by the laws of the State of Delaware, without regard to its conflict of laws principles. Any dispute shall be resolved in the state or federal courts located in Wilmington, Delaware.'],
      ...boiler('Contractor', 'Client'),
    ],
  },

  // ==================================================================
  '02-dev-retainer-moderate': {
    title: 'SOFTWARE DEVELOPMENT RETAINER AGREEMENT',
    body: [
      ['p', 'This Software Development Retainer Agreement (the "Agreement") is made as of 2 April 2026 between Halden Logistics BV, with registered offices at Keizersgracht 210, Amsterdam ("Client"), and the undersigned developer ("Developer").'],
      ['h', '1. Engagement'],
      ['p', 'Client engages Developer on a retainer basis to provide backend development, maintenance, and technical consultation services for Client\u2019s internal dispatch platform (the "Services"). Developer shall make available a minimum of sixty (60) hours per calendar month.'],
      ['h', '2. Fees'],
      ['p', 'Client shall pay Developer at an hourly rate of eighty-five euro (\u20AC85) per hour, invoiced monthly in arrears. ' + C.m_rate],
      ['p', C.m_net60],
      ['h', '3. Scope and Support'],
      ['p', C.m_scope + ' Bug reports shall be submitted through Client\u2019s issue tracker and triaged within two (2) business days.'],
      ['p', 'Work outside the agreed scope shall be quoted separately and shall not commence until approved in writing by Client.'],
      ['h', '4. Intellectual Property'],
      ['p', 'All source code, documentation, and related materials produced by Developer in performance of the Services shall be owned by Client upon payment of the invoice covering the period in which such materials were created. Developer retains ownership of any pre-existing libraries, tools, or frameworks used in the Services, and grants Client a perpetual, non-exclusive licence to use them as incorporated into the deliverables.'],
      ['h', '5. Term and Termination'],
      ['p', C.m_termination],
      ['h', '6. Confidentiality'],
      ['p', C.m_confidentiality + ' This obligation shall continue indefinitely following termination of this Agreement.'],
      ['h', '7. Warranties'],
      ['p', 'Developer warrants that the Services will be performed with reasonable skill and care, and that the deliverables will not knowingly infringe the intellectual property rights of any third party. Developer\u2019s total liability under this Agreement shall not exceed the total fees paid in the twelve (12) months preceding the claim.'],
      ['h', '8. Governing Law'],
      ['p', 'This Agreement is governed by the laws of the Netherlands. The parties submit to the exclusive jurisdiction of the courts of Amsterdam.'],
      ...boiler('Developer', 'Client'),
    ],
  },

  // ==================================================================
  '03-copywriting-clean': {
    title: 'COPYWRITING SERVICES AGREEMENT',
    body: [
      ['p', 'This Copywriting Services Agreement (the "Agreement") is entered into on 18 May 2026 between Ferndale Kitchens Ltd, of 14 Bridge Street, Bristol ("Client"), and the undersigned writer ("Writer").'],
      ['h', '1. Services'],
      ['p', 'Writer shall produce website copy for Client\u2019s new product range, comprising approximately 4,000 words across eight (8) pages, together with twelve (12) short product descriptions, as described in Schedule A (the "Services").'],
      ['h', '2. Fees and Payment'],
      ['p', 'Client shall pay Writer a fixed fee of three thousand two hundred pounds (\u00A33,200). Forty percent (40%) is payable upon signature as a non-refundable deposit, and the balance within fourteen (14) days of final delivery.'],
      ['p', 'Invoices unpaid after fourteen (14) days shall accrue interest at four percent (4%) above the Bank of England base rate, calculated daily, in accordance with applicable late payment legislation.'],
      ['h', '3. Revisions'],
      ['p', 'The fee includes two (2) rounds of revisions per deliverable. Additional revision rounds shall be billed at Writer\u2019s standard rate of sixty pounds (\u00A360) per hour, agreed in advance in writing.'],
      ['h', '4. Scope Changes'],
      ['p', 'Any change to the agreed word count, page count, or subject matter shall be documented in a written change order signed by both parties, specifying the additional fee and any adjustment to the delivery schedule, before the additional work begins.'],
      ['h', '5. Intellectual Property'],
      ['p', 'Upon receipt of full payment, Writer assigns to Client all copyright in the final delivered copy. Until full payment is received, Writer retains all rights in the work and Client has no licence to use it. Writer retains the right to display excerpts of the work in a portfolio or showreel, and to identify Client as a client, unless Client notifies Writer otherwise in writing.'],
      ['h', '6. Term and Termination'],
      ['p', 'Either party may terminate this Agreement upon fourteen (14) days written notice. If Client terminates other than for Writer\u2019s material breach, Client shall pay for all work completed to the date of termination plus fifty percent (50%) of the fee for the remaining, uncommenced work.'],
      ['h', '7. Confidentiality'],
      ['p', 'Each party shall keep confidential the non-public information of the other disclosed in connection with this Agreement, for a period of two (2) years following termination. This obligation does not apply to information that is or becomes publicly available other than through breach of this Agreement.'],
      ['h', '8. Liability'],
      ['p', 'The total liability of either party under this Agreement shall not exceed the total fees payable under it. Neither party is liable for indirect or consequential loss.'],
      ['h', '9. Governing Law and Disputes'],
      ['p', 'This Agreement is governed by the laws of England and Wales. The parties shall attempt in good faith to resolve any dispute through discussion before commencing proceedings. Each party bears its own legal costs.'],
      ...boiler('Writer', 'Client'),
    ],
  },

  // ==================================================================
  '04-video-production-mixed': {
    title: 'VIDEO PRODUCTION AGREEMENT',
    body: [
      ['p', 'This Video Production Agreement (the "Agreement") is made on 7 June 2026 between Arbor Wellness Co., of 88 Sunset Terrace, Austin, Texas ("Client"), and the undersigned producer ("Producer").'],
      ['h', '1. Services'],
      ['p', 'Producer shall plan, shoot, and edit one (1) brand film of approximately ninety (90) seconds, together with three (3) vertical cut-downs for social media, as described in Schedule A (the "Services"). Production shall take place over two (2) shooting days at locations agreed by the parties.'],
      ['h', '2. Fees and Payment'],
      ['p', 'Client shall pay Producer a total fee of twelve thousand dollars ($12,000). ' + C.v_payment],
      ['h', '3. Revisions'],
      ['p', C.v_revisions],
      ['p', C.v_reshoot],
      ['h', '4. Delivery Schedule'],
      ['p', 'Producer shall deliver the first cut within twenty-one (21) days of the final shooting day, and the final edited video within fourteen (14) days of Client\u2019s consolidated revision notes. ' + C.v_late],
      ['h', '5. Intellectual Property'],
      ['p', C.v_ip + ' Producer retains ownership of all raw footage, project files, and outtakes not incorporated into the final edited video.'],
      ['p', C.v_portfolio],
      ['h', '6. Talent and Releases'],
      ['p', 'Client shall obtain and provide to Producer signed appearance releases for all individuals appearing in the video, and location releases for all filming locations, prior to the first shooting day.'],
      ['h', '7. Cancellation'],
      ['p', 'If Client cancels a confirmed shooting day with fewer than seven (7) days notice, Client shall pay fifty percent (50%) of the day rate for that day. Cancellation with fewer than forty-eight (48) hours notice incurs the full day rate.'],
      ['h', '8. Liability'],
      ['p', 'Producer\u2019s total liability under this Agreement shall not exceed the total fees paid by Client. Producer maintains general liability insurance in the amount of one million dollars ($1,000,000).'],
      ['h', '9. Governing Law'],
      ['p', 'This Agreement is governed by the laws of the State of Texas. Any dispute shall be resolved by binding arbitration in Austin, Texas, under the rules of the American Arbitration Association.'],
      ...boiler('Producer', 'Client'),
    ],
  },

  // ==================================================================
  // Rejected on length (FR-2.6), so it needs no flagged clauses: only its
  // word count matters. Each schedule repeats the shared boilerplate with
  // different party roles, as a real master agreement's per-service terms
  // often do.
  '05-oversized-msa': {
    title: 'MASTER SERVICES AGREEMENT',
    body: [
      ['p', 'This Master Services Agreement (the "Agreement") is entered into as of 3 July 2026 (the "Effective Date") between Corvane Industrial Holdings plc, of 1 Harbour Exchange Square, London ("Company"), and the undersigned consultancy ("Supplier"), each a "Party" and together the "Parties".'],
      ['h', '1. Structure of this Agreement'],
      ['p', 'This Agreement sets out the general terms on which Supplier shall provide professional services to Company and its affiliates. Specific services shall be described in one or more statements of work (each a "Statement of Work"), each of which shall reference this Agreement and be signed by authorised representatives of both Parties. In the event of any conflict between this Agreement and a Statement of Work, this Agreement shall prevail unless the Statement of Work expressly identifies the provision of this Agreement it is intended to vary.'],
      ['p', 'The schedules to this Agreement set out the general terms that apply to each category of service. Where a Statement of Work covers more than one category, the schedule for each category applies to the services within it.'],
      ['h', '2. Definitions'],
      ['p', '"Affiliate" means any entity that directly or indirectly controls, is controlled by, or is under common control with a Party. "Business Day" means a day other than a Saturday, Sunday, or public holiday in England. "Deliverables" means all documents, software, designs, reports, and other materials that Supplier is required to deliver under a Statement of Work. "Services" means the services described in each Statement of Work, together with any incidental services reasonably necessary for their performance.'],
      ['h', '3. Governance'],
      ['p', 'Each Party shall appoint a relationship manager with authority to make day-to-day decisions under this Agreement. The relationship managers shall meet at least once each calendar month to review progress against each active Statement of Work, identify risks, and agree any corrective actions. Minutes of each meeting shall be circulated within five (5) Business Days.'],
      ['p', 'Either Party may escalate an unresolved operational issue to a steering committee comprising one senior representative of each Party. The steering committee shall meet within ten (10) Business Days of an escalation notice and shall use reasonable efforts to resolve the issue at that meeting.'],
      ['h', '4. Change Control'],
      ['p', 'Either Party may request a change to the scope, timetable, or charges of a Statement of Work by submitting a written change request. Supplier shall respond within ten (10) Business Days with an assessment of the impact of the change on the charges, the timetable, and any other affected terms. No change shall take effect until a change note is signed by both Parties.'],
      ['h', '5. Charges and Invoicing'],
      ['p', 'Company shall pay the charges set out in each Statement of Work. Unless a Statement of Work provides otherwise, Supplier shall invoice monthly in arrears for time and materials charges, and on achievement of each milestone for fixed-price charges. Each invoice shall be accompanied by reasonable supporting detail. Company shall pay each valid invoice within thirty (30) days of receipt.'],
      ['h', '6. Service Levels'],
      ['p', 'Where a Statement of Work specifies service levels, Supplier shall measure its performance against them each month and report the results to Company within five (5) Business Days of the month end. A failure to meet the same service level in three (3) consecutive months shall entitle Company to require a remediation plan, which Supplier shall prepare within ten (10) Business Days.'],
      ['h', '7. Personnel'],
      ['p', 'Supplier shall ensure that all personnel assigned to the Services are suitably qualified and experienced. Supplier shall use reasonable efforts to maintain continuity of the key personnel named in a Statement of Work, and shall give Company reasonable notice of any proposed replacement.'],
      ['h', '8. Data Protection'],
      ['p', 'Where Supplier processes personal data on behalf of Company, the Parties shall enter into a data processing agreement that complies with applicable data protection law. Supplier shall implement appropriate technical and organisational measures to protect such personal data against unauthorised or unlawful processing, and against accidental loss, destruction, or damage.'],
      ['h', '9. Records and Audit'],
      ['p', 'Supplier shall keep complete and accurate records relating to the Services and the charges for at least three (3) years after the end of the relevant Statement of Work. Company may, on reasonable notice and not more than once in any twelve (12) month period, audit those records to verify compliance with this Agreement.'],
      ['h', '10. Insurance'],
      ['p', 'Supplier shall maintain, with reputable insurers, professional indemnity insurance of not less than two million pounds (£2,000,000) per claim, public liability insurance of not less than five million pounds (£5,000,000), and employer’s liability insurance as required by law. Supplier shall provide certificates of insurance on request, and shall notify Company of any cancellation or material change in cover. The required insurance shall be maintained for the term of this Agreement and for six (6) years after its end.'],
      ['h', 'Schedule 1: General Terms for Consulting Services'],
      ...boiler('Supplier', 'Company'),
      ['h', 'Schedule 2: General Terms for Design Services'],
      ...boiler('Designer', 'Company'),
      ['h', 'Schedule 3: General Terms for Software Development Services'],
      ...boiler('Developer', 'Company'),
      ['h', 'Schedule 4: General Terms for Content Services'],
      ...boiler('Writer', 'Company'),
      ['h', 'Schedule 5: General Terms for Research Services'],
      ...boiler('Researcher', 'Company'),
      ['h', 'Schedule 6: General Terms for Training Services'],
      ...boiler('Trainer', 'Company'),
      ['h', 'Schedule 7: General Terms for Video Production Services'],
      ...boiler('Producer', 'Company'),
      ['h', 'Schedule 8: General Terms for Photography Services'],
      ...boiler('Photographer', 'Company'),
    ],
  },
};

// Fixtures with no contract structure, written byte for byte.
export const plainFixtures = {
  // FR-2.5 via the paste path: 38 words, far under the 200-word floor.
  '07-too-short': {
    ext: 'txt',
    content: 'Hi, following our call, please confirm you can start on the brochure redesign next Monday. We will pay the agreed day rate on completion. Let me know if you need anything before you start. Kind regards, the studio.\n',
  },
  // FR-2.3: plain text saved with a .pdf extension. Its first four bytes are
  // "FREE" (46 52 45 45), not the %PDF signature, so intake must reject it by
  // content, whatever its name or declared type says.
  '08-not-really-a-pdf': {
    ext: 'pdf',
    content: 'FREELANCE SERVICES AGREEMENT\n\nThis agreement was exported as plain text and then renamed with a .pdf extension. It is not a PDF: nothing in it is a PDF structure, and a PDF parser handed these bytes has nothing to read.\n',
  },
};

// ---- 13 stress long report ----
// The long-report case, ported from the UI prototype (docs/design/ClauseCheck.html,
// FIX.stress). The prototype numbered it 09; SRS section 11.1 assigns 09 to
// 09-injection-attempt, so it is 13 here (BUILD-PLAN decision D-E). Its twelve
// findings are clauses from fixtures 01, 04 and 02, referenced through C and never
// restated (section 11.3). Ported with two changes: the prototype glossary markup
// [[term|text]] is reduced to its text, since the API returns plain strings, and
// the summary says "seven marked high" where the prototype said "three",
// which contradicted its own 7 high findings.
export const stressReport = {
  documentId: 'cm0stress13document0000',
  analysisId: 'cm0stress13analysis0000',
  createdAt: '2026-08-21T14:31:00.000Z',
  wordCount: 3940,
  discardedFindings: 2,
  summary: 'This master services agreement is one-sided in most of the sections that matter to you: unlimited revisions, uncapped indemnity, ownership on creation rather than on payment, and a two-year non-compete. Twelve clauses are worth a second look \u2014 start with the seven marked high.',
  missingClauses: [
    'No deposit or upfront payment',
    'No late-payment interest',
    'No revision limit',
    'No kill fee',
    'No cap on your liability',
    'IP transfer isn\u2019t conditional on payment',
  ],
  findings: [
    { excerpt: C.h_revisions, category: 'scope', severity: 'high',
      explanation: 'There\u2019s no limit on revisions and no definition of \u201Csatisfied,\u201D so the project can continue indefinitely at the client\u2019s discretion without additional payment.',
      suggestedChange: 'Ask for a specific number of revision rounds \u2014 two is standard \u2014 with additional rounds billed at your hourly rate.' },
    { excerpt: C.h_ip, category: 'ip', severity: 'high',
      explanation: 'This hands over work you made before this project existed, and the assignment takes effect the moment you create something rather than when you\u2019re paid \u2014 so an unpaid final invoice leaves you with nothing to hold.',
      suggestedChange: 'Ask that this cover only deliverables made under this agreement, and that ownership transfer on receipt of final payment. Offer a licence for anything you made beforehand instead of assigning it.' },
    { excerpt: C.h_indemnity, category: 'liability', severity: 'high',
      explanation: 'This is an uncapped indemnity \u2014 one dispute could cost you far more than the project pays, including claims caused by material the client gave you.',
      suggestedChange: 'Ask to cap your total liability at the fees paid under this agreement, and to exclude claims arising from client-supplied content or client instructions.' },
    { excerpt: C.h_noncompete, category: 'confidentiality', severity: 'high',
      explanation: 'This is a non-compete: two years across an entire industry can remove a large share of the clients you\u2019d normally work for \u2014 a real cost, for something you\u2019re not being paid extra to accept.',
      suggestedChange: 'Ask to narrow this to a short list of named direct competitors and to shorten it to six months \u2014 or to drop it, since you\u2019re a contractor rather than an employee.' },
    { excerpt: C.h_termination, category: 'termination', severity: 'high',
      explanation: 'The client can end the project at any point and owe you nothing for work already underway \u2014 there is no kill fee, so the whole cost of a cancellation lands on you.',
      suggestedChange: 'Ask for 14 days\u2019 notice, payment for all work completed to date, and 25% of the remaining fee if the project is cancelled after it starts.' },
    { excerpt: C.h_payment, category: 'payment', severity: 'medium',
      explanation: 'Net-90 is three months of financing the client\u2019s project, and the clock only starts on acceptance \u2014 which the client controls and could delay indefinitely.',
      suggestedChange: 'Ask for net-14 or net-30 counted from your invoice date, and for deliverables to be treated as accepted if no feedback arrives within five working days.' },
    { excerpt: C.h_expenses, category: 'payment', severity: 'low',
      explanation: 'Minor on its own, but licences for fonts and stock imagery on a branding project can run into hundreds of dollars that come straight out of your fee.',
      suggestedChange: 'Ask for materials bought specifically for this project to be reimbursed at cost, or add an allowance for them to the fee.' },
    { excerpt: C.v_reshoot, category: 'scope', severity: 'high',
      explanation: 'A reshoot means crew, location and equipment all over again. This clause makes that free and unlimited whenever the client changes their mind \u2014 the expensive twin of unlimited revisions.',
      suggestedChange: 'Ask that free reshoots cover technical defects only, and that reshoots requested for creative reasons be quoted separately at your day rate.' },
    { excerpt: C.v_late, category: 'liability', severity: 'high',
      explanation: '5% a day reaches the entire fee in twenty days, with no cap and no exception for delays the client causes \u2014 a week of late feedback from them could still cost you a third of the project.',
      suggestedChange: 'Ask to cap the total penalty at 10% of the fee, and to stop the clock for any delay caused by late client feedback, missing assets, or scheduling changes.' },
    { excerpt: C.v_portfolio, category: 'confidentiality', severity: 'medium',
      explanation: 'For a video producer the showreel is how the next job arrives. An absolute ban makes this project invisible in your work, which is a career cost rather than an admin detail.',
      suggestedChange: 'Ask for the right to show the finished work after it\u2019s publicly released \u2014 or, if the client needs it kept private, a fee that reflects what the silence is worth.' },
    { excerpt: C.m_net60, category: 'payment', severity: 'medium',
      explanation: 'Net-60 means financing the client\u2019s project for two months, and \u201Cundisputed\u201D lets any disagreement pause the clock on the whole invoice rather than just the disputed part.',
      suggestedChange: 'Ask for net-14 or net-30, and for a dispute to pause payment only on the disputed portion of the invoice.' },
    { excerpt: C.m_confidentiality, category: 'confidentiality', severity: 'medium',
      explanation: 'There\u2019s no end date and it covers the client\u2019s identity, so as written you couldn\u2019t list them in your portfolio, mention the work to a future client, or put it on your CV.',
      suggestedChange: 'Ask for an explicit carve-out allowing you to name the client and describe the work in your portfolio, and for the clause to expire after two or three years.' },
  ],
};
