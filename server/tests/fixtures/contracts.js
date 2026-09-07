// ClauseCheck test fixtures.
// Every flagged clause is defined ONCE here and referenced by both the document
// builder and the answer key, so expected.json excerpts always match the text
// that actually ships in the .docx / .pdf. Excerpt verification (FR-3.3) is a
// verbatim substring check, so drift between the two would silently break TR-3.

const C = {
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

const contracts = {

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
};

module.exports = { C, contracts };
